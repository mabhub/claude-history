import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import pc from 'picocolors';

/**
 * Shared visual marker for cwds that no longer exist on disk. Reused by the
 * TUI list/header and the non-interactive `ls` command so the wording stays
 * in sync across entry points.
 */
export const MISSING = {
  badge: pc.red('⚠'),
  label: pc.red('(dossier supprimé)'),
};

/**
 * Encode a working directory path the same way Claude Code does:
 * every character outside [a-zA-Z0-9] is replaced by '-'. Examples:
 *   '/home/you/claude'        -> '-home-you-claude'
 *   '/home/you/.config/foo'   -> '-home-you--config-foo'
 *   '/home/you/Santé/2026'    -> '-home-you-Sant--2026'
 * @param {string} cwd - Absolute working directory path
 * @returns {string} Encoded directory name used under ~/.claude/projects/
 */
export const encodeCwd = cwd => cwd.replaceAll(/[^a-zA-Z0-9]/g, '-');

/**
 * Default location of the Claude Code projects directory.
 * @returns {string} Path to ~/.claude/projects
 */
export const defaultProjectsRoot = () => path.join(os.homedir(), '.claude', 'projects');

/**
 * Returns the absolute path of the Claude Code projects directory for a given cwd.
 * @param {string} cwd - Absolute working directory path
 * @param {string} [projectsRoot] - Override the projects root (defaults to ~/.claude/projects)
 * @returns {string} Path under <projectsRoot>/<encoded>
 */
export const projectsDirFor = (cwd, projectsRoot = defaultProjectsRoot()) =>
  path.join(projectsRoot, encodeCwd(cwd));

/**
 * Format a Date (or ISO string) into a compact local date-time: YYYY-MM-DD HH:mm.
 * @param {Date|string|number} input - Date input
 * @returns {string} Formatted date
 */
export const formatDate = input => {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '????-??-?? ??:??';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Relative-age thresholds in seconds, largest-first. The first bucket whose
// `limit` the elapsed time is below decides the unit; `null` is the open-ended
// top bucket (years). `div` converts seconds into that unit.
const AGE_UNITS = [
  { limit: 60, label: elapsed => (elapsed < 5 ? 'à l\'instant' : `il y a ${Math.floor(elapsed)}s`) },
  { limit: 3600, label: elapsed => `il y a ${Math.floor(elapsed / 60)}min` },
  { limit: 86400, label: elapsed => `il y a ${Math.floor(elapsed / 3600)}h` },
  { limit: 604800, label: elapsed => `il y a ${Math.floor(elapsed / 86400)}j` },
  { limit: 2592000, label: elapsed => `il y a ${Math.floor(elapsed / 604800)}sem` },
  { limit: 31536000, label: elapsed => `il y a ${Math.floor(elapsed / 2592000)}mois` },
  { limit: null, label: elapsed => `il y a ${Math.floor(elapsed / 31536000)}an${elapsed >= 63072000 ? 's' : ''}` },
];

/**
 * Format a past date as a compact French relative age (e.g. "il y a 3j").
 * Future or invalid dates fall back to "?". The reference point defaults to
 * now but is injectable for deterministic tests.
 * @param {Date|string|number} input - Date input (typically a session's lastActivity)
 * @param {number} [now=Date.now()] - Reference epoch in ms
 * @returns {string} Relative age label
 */
export const formatAge = (input, now = Date.now()) => {
  const d = input instanceof Date ? input : new Date(input);
  const ms = d.getTime();
  if (Number.isNaN(ms)) return '?';
  const elapsed = (now - ms) / 1000;
  if (elapsed < 0) return '?';
  const bucket = AGE_UNITS.find(u => u.limit === null || elapsed < u.limit);
  return bucket.label(elapsed);
};

/**
 * Format a token count compactly: "812 tok", "4.2K tok", "341K tok", "1.2M tok".
 * One decimal only below 10 of a unit, where it still carries information.
 * @param {number|null} tokens - Token count
 * @returns {string} Formatted count, or "?" when unknown
 */
export const formatTokens = tokens => {
  if (!Number.isFinite(tokens) || tokens < 0) return '?';
  if (tokens < 1000) return `${tokens} tok`;
  // Round in K first, so 999_600 promotes to "1M" instead of reading "1000K".
  const unit = Math.round(tokens / 1000) < 1000 ? ['K', 1e3] : ['M', 1e6];
  const value = tokens / unit[1];
  const rounded = value < 10 ? Number(value.toFixed(1)) : Math.round(value);
  return `${rounded}${unit[0]} tok`;
};

/**
 * Whether a session's context is still in the prompt cache, and a short label
 * saying for how long, or what a resume reloads once it is not. Unknown
 * expiry counts as expired: resuming then pays the full context.
 * @param {{contextTokens: number|null, cacheExpiresAt: Date|null}} session - A session from listSessions
 * @param {number} [now=Date.now()] - Reference epoch (injectable for tests)
 * @returns {{warm: boolean, label: string}}
 */
export const cacheStatus = (session, now = Date.now()) => {
  const left = session.cacheExpiresAt ? session.cacheExpiresAt.getTime() - now : 0;
  const minutes = Math.ceil(left / 60000);
  if (left > 0) return { warm: true, label: `cache chaud · ${minutes} min restante${minutes > 1 ? 's' : ''}` };
  const size = Number.isFinite(session.contextTokens) ? `${formatTokens(session.contextTokens)} à recharger` : 'taille inconnue';
  return { warm: false, label: `cache expiré · ${size}` };
};

// Fixed display widths so age and tokens line up into columns across rows. The
// raw (uncolored) strings are padded before coloring — ANSI codes would break
// padEnd/padStart length math.
const AGE_WIDTH = 13;
const TOKENS_WIDTH = 8;

// RGB values Claude Code paints a `/color` with: its `<name>_FOR_SUBAGENTS_ONLY`
// theme keys, identical in the default dark and light themes.
const SESSION_COLORS = {
  red: [220, 38, 38],
  blue: [106, 155, 204],
  green: [22, 163, 74],
  yellow: [202, 138, 4],
  purple: [130, 125, 189],
  orange: [217, 119, 87],
  pink: [196, 102, 134],
  cyan: [8, 145, 178],
};

/** Color names `/color` accepts besides `default`, in Claude Code's theme order. */
export const SESSION_COLOR_NAMES = Object.keys(SESSION_COLORS);

const COLOR_CYCLE = [...SESSION_COLOR_NAMES, 'default'];

/**
 * Step to the next (or previous) `/color` in a loop that includes 'default'
 * (no color) between cyan and red. A missing or unknown color counts as
 * 'default', so the first step forward lands on red.
 * @param {string|null|undefined} current - Raw `agentColor`
 * @param {1|-1} step - Direction
 * @returns {string} One of SESSION_COLOR_NAMES, or 'default'
 */
export const cycleColor = (current, step) => {
  const from = COLOR_CYCLE.includes(current) ? COLOR_CYCLE.indexOf(current) : COLOR_CYCLE.length - 1;
  return COLOR_CYCLE[(from + step + COLOR_CYCLE.length) % COLOR_CYCLE.length];
};

/**
 * Tint a title with the session's `/color`, in Claude Code's own RGB value.
 * Any value outside the known palette (no color, a reset to default, …) leaves
 * the title untouched.
 * @param {string} title - Title text
 * @param {string|null} color - Raw `agentColor` from the transcript
 * @param {boolean} [enabled=pc.isColorSupported] - Whether to emit ANSI codes
 * @returns {string} The title, wrapped in a 24-bit foreground color if known
 */
export const tintTitle = (title, color, enabled = pc.isColorSupported) => {
  const rgb = Object.hasOwn(SESSION_COLORS, color) ? SESSION_COLORS[color] : null;
  if (!rgb || !enabled) return title;
  return `\x1b[38;2;${rgb.join(';')}m${title}\x1b[39m`;
};

// Context-size palette of claude-statusline's context gauge (its QUOTA_COLORS
// and CTX_THRESHOLDS): dark green → green → light green → yellow → amber →
// orange → red → crimson → violet. Thresholds are the upper bound, in thousands
// of tokens, of each level but the last: /compact is advised from 150-200K,
// turns past 200K carry most of the cost, past 400K one costs ~3× a 100-200K one.
const CONTEXT_COLORS = [
  [30, 142, 62], [76, 175, 80], [139, 195, 74], [240, 200, 0], [255, 160, 0],
  [255, 109, 0], [229, 57, 53], [194, 24, 91], [123, 31, 162],
];
const CONTEXT_THRESHOLDS_K = [60, 90, 120, 150, 175, 200, 300, 400];

/**
 * Tint text with claude-statusline's color for a context size, so the cost of
 * a cold resume stands out at a glance.
 * @param {string} text - Text to color (already padded)
 * @param {number|null} tokens - Context size in tokens
 * @param {boolean} [enabled=pc.isColorSupported] - Whether to emit ANSI codes
 * @returns {string} The text in a 24-bit foreground color, dimmed when the size is unknown
 */
export const tintTokens = (text, tokens, enabled = pc.isColorSupported) => {
  if (!enabled) return text;
  if (!Number.isFinite(tokens)) return pc.dim(text);
  const thousands = Math.floor(tokens / 1000);
  const level = CONTEXT_THRESHOLDS_K.findIndex(max => thousands <= max);
  const rgb = CONTEXT_COLORS[level === -1 ? CONTEXT_COLORS.length - 1 : level];
  return `\x1b[38;2;${rgb.join(';')}m${text}\x1b[39m`;
};

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Emoji and East Asian wide/fullwidth ranges take two terminal columns.
const WIDE = /\p{Extended_Pictographic}|[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u;

/**
 * Number of terminal columns a string takes, ANSI codes excluded. Counts
 * grapheme clusters (so combining accents add nothing) and wide characters as
 * two — enough for titles; not a full East Asian Width implementation.
 * @param {string} text - Possibly colored text
 * @returns {number} Column count
 */
export const visibleWidth = text => {
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(stripVTControlCharacters(text))) {
    width += WIDE.test(segment) ? 2 : 1;
  }
  return width;
};

/**
 * Paint a row's background across the terminal, for the active list row.
 * Padded to one column short of the width: filling the last column makes some
 * terminals wrap. The colored columns inside only reset the foreground (39)
 * and intensity (22), so the background holds across them.
 * @param {string} text - Row, possibly colored
 * @param {Array<number>} rgb - Background `[r, g, b]` in 0..255
 * @param {number} columns - Terminal width
 * @returns {string} The row on a 24-bit background
 */
export const highlightRow = (text, rgb, columns) => {
  const padding = ' '.repeat(Math.max(0, columns - 1 - visibleWidth(text)));
  return `\x1b[48;2;${rgb.join(';')}m${text}${padding}\x1b[49m`;
};

/**
 * Word-wrap plain text to `width` columns, whitespace collapsed. Past
 * `maxLines`, the last kept line ends with "…". A word wider than `width`
 * keeps its own line and overflows.
 * @param {string} text - Plain text (no ANSI codes)
 * @param {number} width - Maximum visible width of a line
 * @param {number} [maxLines=Infinity] - Maximum number of lines
 * @returns {Array<string>} The lines
 */
export const wrapText = (text, width, maxLines = Infinity) => {
  const lines = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines.at(-1);
    if (last !== undefined && visibleWidth(`${last} ${word}`) <= width) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept.at(-1);
  kept[maxLines - 1] = visibleWidth(`${last} …`) <= width ? `${last} …` : `${last.slice(0, -2).trimEnd()} …`;
  return kept;
};

/**
 * Render the shared columns of one session list row: short id, absolute date,
 * relative age, context size in tokens, then title. Used by both the `ls` command and the TUI so
 * their columns stay identical. The caller prefixes any leading badge itself.
 * @param {Object} session - A session from listSessions
 * @param {string} session.sessionId - Full UUID
 * @param {Date} session.lastActivity - Last message time (drives date + age)
 * @param {number|null} session.contextTokens - Context a resume reloads, null if unknown
 * @param {string} session.title - Resolved title
 * @param {string|null} [session.color] - Raw `/color` value, tints the title
 * @param {number} [now=Date.now()] - Reference epoch for age (injectable for tests)
 * @returns {string} A colored, column-aligned row (no leading badge)
 */
export const formatSessionRow = (session, now = Date.now()) => {
  const id = pc.dim(session.sessionId.slice(0, 8));
  const date = pc.cyan(formatDate(session.lastActivity));
  const age = pc.dim(formatAge(session.lastActivity, now).padEnd(AGE_WIDTH));
  const tokens = tintTokens(formatTokens(session.contextTokens).padStart(TOKENS_WIDTH), session.contextTokens);
  const title = session.title === '(sans titre)'
    ? pc.dim(session.title)
    : tintTitle(session.title, session.color);
  return `${id}  ${date}  ${age}  ${tokens}  ${title}`;
};

/**
 * Truncate a string to a maximum length, adding an ellipsis if cut.
 * @param {string} s - Input string
 * @param {number} max - Maximum length
 * @returns {string} Truncated string
 */
export const truncate = (s, max) => {
  if (!s) return '';
  const flat = s.replaceAll(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/**
 * Resolve a short or full session id against a list of candidate session ids.
 * Returns the matching full session id or throws if zero / multiple matches.
 * @param {string} idOrPrefix - Short prefix (>=4 chars) or full UUID
 * @param {Array<string>} sessionIds - Candidate full session ids
 * @returns {string} Full session id
 */
export const resolveId = (idOrPrefix, sessionIds) => {
  if (!idOrPrefix || idOrPrefix.length < 4) {
    throw new Error('Identifier too short (need at least 4 characters).');
  }
  const matches = sessionIds.filter(id => id.startsWith(idOrPrefix));
  if (matches.length === 0) {
    throw new Error(`No conversation matches id "${idOrPrefix}".`);
  }
  if (matches.length > 1) {
    const list = matches.map(id => id.slice(0, 8)).join(', ');
    throw new Error(`Ambiguous id "${idOrPrefix}" (matches: ${list}). Use a longer prefix.`);
  }
  return matches[0];
};

/**
 * Detect whether `glow` (the markdown TUI renderer) is available in PATH.
 * Cached after first call.
 * @returns {boolean} True if `glow` can be spawned
 */
let glowAvailable;
export const hasGlow = () => {
  if (glowAvailable === undefined) {
    const probe = spawnSync('glow', ['--version'], { stdio: 'ignore' });
    glowAvailable = probe.status === 0;
  }
  return glowAvailable;
};

/**
 * Pipe a string into a viewer. Picks `glow -p` when markdown is true and
 * glow is installed, otherwise falls back to $PAGER (or `less -R`).
 * @param {Object} options
 * @param {string} options.text - Content to display
 * @param {boolean} [options.markdown=false] - Hint that text is markdown
 * @returns {Promise<void>}
 */
export const pipeToViewer = ({ text, markdown = false }) =>
  new Promise((resolve, reject) => {
    const [cmd, ...args] = pickViewer(markdown);
    const child = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', err => {
      if (err.code === 'ENOENT') {
        process.stdout.write(text);
        resolve();
      } else {
        reject(err);
      }
    });
    child.on('close', () => resolve());
    child.stdin.on('error', err => {
      if (err.code !== 'EPIPE') reject(err);
    });
    child.stdin.end(text);
  });

const pickViewer = markdown => {
  if (markdown && hasGlow()) return ['glow', '-p', '-'];
  const pagerEnv = process.env.PAGER?.trim();
  return pagerEnv ? pagerEnv.split(/\s+/) : ['less', '-R'];
};
