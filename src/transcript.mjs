import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import pc from 'picocolors';
import { formatDate, truncate } from './util.mjs';

/**
 * Render a JSONL transcript into a human-readable string.
 * @param {Object} options
 * @param {string} options.filePath - Path to the .jsonl file
 * @param {boolean} [options.raw=false] - If true, dump pretty-printed JSON
 * @param {boolean} [options.verbose=false] - If true, include system/hook entries
 * @returns {Promise<string>} Formatted transcript
 */
export const renderTranscript = async ({ filePath, raw = false, verbose = false }) => {
  const chunks = [];
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      chunks.push(pc.red(`[unparseable line] ${line}`));
      continue;
    }
    if (raw) {
      chunks.push(JSON.stringify(entry, null, 2));
      continue;
    }
    const rendered = renderEntry(entry, { verbose });
    if (rendered) chunks.push(rendered);
  }
  return `${chunks.join('\n\n')}\n`;
};

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

const renderEntry = (entry, { verbose }) => {
  const ts = entry.timestamp ? pc.dim(`[${formatDate(entry.timestamp)}]`) : '';

  if (entry.type === 'user') return renderUser(entry, ts);
  if (entry.type === 'assistant') return renderAssistant(entry, ts);
  if (SYSTEM_TYPES.has(entry.type)) {
    return verbose ? pc.dim(`${ts} (${entry.type})`) : null;
  }
  return verbose ? pc.dim(`${ts} (${entry.type ?? 'unknown'})`) : null;
};

const renderUser = (entry, ts) => {
  const content = entry.message?.content;
  const parts = [];
  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string') {
        parts.push(c.text);
      } else if (c?.type === 'tool_result') {
        const isError = c.is_error === true;
        const tag = isError ? pc.red('tool_result(error)') : pc.dim('tool_result');
        const body = stringifyToolContent(c.content);
        parts.push(`${tag}: ${isError ? body : truncate(body, 200)}`);
      } else if (c?.type === 'image') {
        parts.push(pc.dim('[image]'));
      }
    }
  }
  if (parts.length === 0) return null;
  return `${pc.bold(pc.cyan('## User'))} ${ts}\n${parts.join('\n')}`;
};

const renderAssistant = (entry, ts) => {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;
  const lines = [];
  for (const c of content) {
    if (c?.type === 'text' && typeof c.text === 'string') {
      lines.push(c.text);
    } else if (c?.type === 'tool_use') {
      const name = c.name ?? 'tool';
      const argsBlurb = summarizeToolInput(c.input);
      lines.push(pc.yellow(`→ ${name}(${argsBlurb})`));
    } else if (c?.type === 'thinking' && typeof c.thinking === 'string') {
      lines.push(pc.dim(`(thinking) ${truncate(c.thinking, 200)}`));
    }
  }
  if (lines.length === 0) return null;
  return `${pc.bold(pc.green('## Assistant'))} ${ts}\n${lines.join('\n')}`;
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
