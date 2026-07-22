import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
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

/**
 * Format a byte count as a compact human-readable size (B, KB, MB, GB). Uses
 * 1024-based units and drops the decimal for whole numbers and for bytes.
 * @param {number} bytes - Size in bytes
 * @returns {string} e.g. "812 B", "3.4 KB", "12 MB"
 */
export const formatSize = bytes => {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // A value just under the next threshold (e.g. 1048575 B) rounds up to 1024.0
  // in its unit — promote it one unit so it reads "1 MB", not "1024.0 KB".
  if (unit < units.length - 1 && Number(value.toFixed(1)) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  // Round once, then drop the decimal for whole numbers (incl. a promoted 1.0)
  // and for the base byte unit.
  const oneDp = Number(value.toFixed(1));
  const rounded = unit === 0 || Number.isInteger(oneDp) ? String(oneDp) : oneDp.toFixed(1);
  return `${rounded} ${units[unit]}`;
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
