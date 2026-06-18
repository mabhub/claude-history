import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import pc from 'picocolors';
import { formatDate, truncate } from './util.mjs';

const SYSTEM_TYPES = new Set([
  'attachment',
  'hook_success',
  'hook_system_message',
  'hook_additional_context',
  'system',
  'agent-name',
  'bridge-session',
  'permission-mode',
  'last-prompt',
  'auto_mode',
  'command_permissions',
  'deferred_tools_delta',
  'diagnostics',
  'file-history-snapshot',
  'skill_listing',
  'custom-title',
  'ai-title',
]);

/**
 * Stylers wrap text snippets according to the output target.
 *   - 'ansi'     : terminal escape codes (for less/cat)
 *   - 'markdown' : Markdown markers (for glow or further processing)
 */
const STYLERS = {
  ansi: {
    userHeader: ts => `${pc.bold(pc.cyan('## User'))} ${ts}`,
    assistantHeader: ts => `${pc.bold(pc.green('## Assistant'))} ${ts}`,
    timestamp: ts => pc.dim(`[${ts}]`),
    dim: t => pc.dim(t),
    toolCall: t => pc.yellow(t),
    toolResultLabel: () => pc.dim('tool_result'),
    toolResultErrorLabel: () => pc.red('tool_result(error)'),
    unparseable: t => pc.red(t),
  },
  markdown: {
    userHeader: ts => `## User ${ts}`,
    assistantHeader: ts => `## Assistant ${ts}`,
    timestamp: ts => `*[${ts}]*`,
    dim: t => `*${t}*`,
    toolCall: t => `**${t}**`,
    toolResultLabel: () => '*tool_result*',
    toolResultErrorLabel: () => '**tool_result(error)**',
    unparseable: t => `> ${t}`,
  },
};

/**
 * Render a JSONL transcript into a human-readable string.
 * @param {Object} options
 * @param {string} options.filePath - Path to the .jsonl file
 * @param {boolean} [options.raw=false] - If true, dump pretty-printed JSON
 * @param {boolean} [options.verbose=false] - If true, include system/hook entries
 * @param {'ansi'|'markdown'} [options.style='ansi'] - Output styling target
 * @returns {Promise<string>} Formatted transcript
 */
export const renderTranscript = async ({
  filePath, raw = false, verbose = false, style = 'ansi',
}) => {
  const styler = STYLERS[style] ?? STYLERS.ansi;
  const chunks = [];
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        chunks.push(styler.unparseable(`[unparseable line] ${line}`));
        continue;
      }
      if (raw) {
        chunks.push(JSON.stringify(entry, null, 2));
        continue;
      }
      const rendered = renderEntry(entry, { verbose, styler });
      if (rendered) chunks.push(rendered);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return `${chunks.join('\n\n')}\n`;
};

const renderEntry = (entry, { verbose, styler }) => {
  const ts = entry.timestamp ? styler.timestamp(formatDate(entry.timestamp)) : '';
  const renderer = ENTRY_RENDERERS[entry.type];
  if (renderer) return renderer(entry, ts, styler);
  if (!verbose) return null;
  const label = SYSTEM_TYPES.has(entry.type) ? entry.type : (entry.type ?? 'unknown');
  return styler.dim(`${ts} (${label})`);
};

const LOCAL_COMMAND_PATTERNS = [
  // /command invocation block emitted by Claude Code when a slash command runs.
  [/<command-name>([^<]*)<\/command-name>\s*<command-message>[^<]*<\/command-message>\s*<command-args>([^<]*)<\/command-args>/g,
    (_m, name, args) => `[${name.trim()}${args.trim() ? ` ${args.trim()}` : ''}]`],
  // Standalone caveat noise — drop entirely.
  [/<local-command-caveat>[^<]*<\/local-command-caveat>\s*/g, () => ''],
  // Wrap stdout snippets compactly.
  [/<local-command-stdout>([^<]*)<\/local-command-stdout>/g,
    (_m, body) => `[stdout] ${body.trim()}`],
];

/**
 * Strip Claude Code's internal slash-command XML wrappers from user text.
 * Returns plain text — caller is responsible for any styling.
 * @param {string} text - Raw user text
 * @returns {string} Cleaned text (may be empty)
 */
export const cleanUserText = text =>
  LOCAL_COMMAND_PATTERNS.reduce((acc, [re, repl]) => acc.replaceAll(re, repl), text).trim();

const renderUser = (entry, ts, styler) => {
  const content = entry.message?.content;
  const parts = [];
  if (typeof content === 'string') {
    const cleaned = cleanUserText(content);
    if (cleaned) parts.push(cleaned);
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string') {
        const cleaned = cleanUserText(c.text);
        if (cleaned) parts.push(cleaned);
      } else if (c?.type === 'tool_result') {
        const isError = c.is_error === true;
        const label = isError ? styler.toolResultErrorLabel() : styler.toolResultLabel();
        const body = stringifyToolContent(c.content);
        parts.push(`${label}: ${isError ? body : truncate(body, 200)}`);
      } else if (c?.type === 'image') {
        parts.push(styler.dim('[image]'));
      }
    }
  }
  if (parts.length === 0) return null;
  return `${styler.userHeader(ts)}\n${parts.join('\n')}`;
};

const renderAssistant = (entry, ts, styler) => {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;
  const lines = [];
  for (const c of content) {
    if (c?.type === 'text' && typeof c.text === 'string') {
      lines.push(c.text);
    } else if (c?.type === 'tool_use') {
      const name = c.name ?? 'tool';
      const argsBlurb = summarizeToolInput(c.input);
      lines.push(styler.toolCall(`→ ${name}(${argsBlurb})`));
    } else if (c?.type === 'thinking' && typeof c.thinking === 'string') {
      lines.push(styler.dim(`(thinking) ${truncate(c.thinking, 200)}`));
    }
  }
  if (lines.length === 0) return null;
  return `${styler.assistantHeader(ts)}\n${lines.join('\n')}`;
};

const ENTRY_RENDERERS = {
  user: renderUser,
  assistant: renderAssistant,
};

const summarizeToolInput = input => {
  if (!input || typeof input !== 'object') return '';
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  const pairs = keys.slice(0, 3).map(k => {
    const v = input[k];
    const str = typeof v === 'string' ? `"${truncate(v, 60)}"` : JSON.stringify(v);
    return `${k}=${truncate(str, 80)}`;
  });
  const suffix = keys.length > 3 ? `, …+${keys.length - 3}` : '';
  return `${pairs.join(', ')}${suffix}`;
};

const stringifyToolContent = content => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(c => (typeof c?.text === 'string' ? c.text : JSON.stringify(c)))
      .join(' ');
  }
  return JSON.stringify(content ?? '');
};
