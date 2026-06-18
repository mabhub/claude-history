import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

/**
 * Encode a working directory path the same way Claude Code does:
 * replace every '/' with '-'. Example: '/home/you/claude' -> '-home-you-claude'.
 * @param {string} cwd - Absolute working directory path
 * @returns {string} Encoded directory name used under ~/.claude/projects/
 */
export const encodeCwd = cwd => cwd.replaceAll('/', '-');

/**
 * Returns the absolute path of the Claude Code projects directory for a given cwd.
 * @param {string} cwd - Absolute working directory path
 * @returns {string} Path under ~/.claude/projects/<encoded>
 */
export const projectsDirFor = cwd =>
  path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));

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
 * Resolve a short or full session id against the list of available sessions.
 * Returns the matching full session id or throws if zero / multiple matches.
 * @param {string} idOrPrefix - Short prefix (>=4 chars) or full UUID
 * @param {Array<{sessionId: string}>} sessions - Candidate sessions
 * @returns {string} Full session id
 */
export const resolveId = (idOrPrefix, sessions) => {
  if (!idOrPrefix || idOrPrefix.length < 4) {
    throw new Error('Identifier too short (need at least 4 characters).');
  }
  const matches = sessions.filter(s => s.sessionId.startsWith(idOrPrefix));
  if (matches.length === 0) {
    throw new Error(`No conversation matches id "${idOrPrefix}".`);
  }
  if (matches.length > 1) {
    const list = matches.map(m => m.sessionId.slice(0, 8)).join(', ');
    throw new Error(`Ambiguous id "${idOrPrefix}" (matches: ${list}). Use a longer prefix.`);
  }
  return matches[0].sessionId;
};

/**
 * Pipe a string into the user's pager ($PAGER, fallback `less -R`).
 * Resolves when the pager exits.
 * @param {string} text - Content to display
 * @returns {Promise<void>}
 */
export const pipeToPager = text =>
  new Promise((resolve, reject) => {
    const pagerEnv = process.env.PAGER?.trim();
    const [cmd, ...args] = pagerEnv ? pagerEnv.split(/\s+/) : ['less', '-R'];
    const child = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', err => {
      // Fallback: just print to stdout.
      if (err.code === 'ENOENT') {
        process.stdout.write(text);
        resolve();
      } else {
        reject(err);
      }
    });
    child.on('close', () => resolve());
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
