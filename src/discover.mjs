import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { projectsDirFor, truncate } from './util.mjs';

/**
 * Walk up from `startCwd` until we find a Claude projects directory that
 * contains at least one .jsonl file, or until we hit the filesystem root.
 * @param {string} startCwd - Absolute path to start from
 * @returns {Promise<{dir: string|null, cwd: string|null, walkedUp: boolean}>}
 */
export const findProjectDir = async startCwd => {
  let current = path.resolve(startCwd);
  const original = current;
  while (true) {
    const dir = projectsDirFor(current);
    const hasJsonl = await dirContainsJsonl(dir);
    if (hasJsonl) {
      return { dir, cwd: current, walkedUp: current !== original };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return { dir: null, cwd: null, walkedUp: false };
    }
    current = parent;
  }
};

const dirContainsJsonl = async dir => {
  try {
    const entries = await fs.readdir(dir);
    return entries.some(name => name.endsWith('.jsonl'));
  } catch {
    return false;
  }
};

/**
 * Read the header of a .jsonl transcript, extracting metadata without
 * loading the whole file. Stops after either:
 *   - the first ~80 lines (enough to find a title), or
 *   - hitting EOF.
 * Then reads the file once more from the end (cheaply, via tail) to find
 * the latest custom-title / ai-title entries.
 * @param {string} filePath - Path to the .jsonl file
 * @returns {Promise<{firstTimestamp: string|null, firstUserPrompt: string|null,
 *                   customTitle: string|null, aiTitle: string|null}>}
 */
const readJsonlMetadata = async filePath => {
  let firstTimestamp = null;
  let firstUserPrompt = null;
  let customTitle = null;
  let aiTitle = null;

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!firstTimestamp && typeof entry.timestamp === 'string') {
      firstTimestamp = entry.timestamp;
    }
    if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
      customTitle = entry.customTitle;
    }
    if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') {
      aiTitle = entry.aiTitle;
    }
    if (!firstUserPrompt && entry.type === 'user') {
      firstUserPrompt = extractUserText(entry);
    }
  }
  return { firstTimestamp, firstUserPrompt, customTitle, aiTitle };
};

/**
 * Extract a human-readable text from a "user" JSONL entry.
 * @param {Object} entry - Parsed JSONL line
 * @returns {string|null} Plain-text prompt or null if not extractable
 */
const extractUserText = entry => {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter(c => c?.type === 'text' && typeof c.text === 'string')
      .map(c => c.text);
    if (textParts.length > 0) return textParts.join(' ');
  }
  return null;
};

/**
 * List all conversations in a Claude projects directory.
 * @param {string} dir - Directory containing .jsonl transcripts
 * @returns {Promise<Array<Object>>} Sessions sorted by mtime desc
 */
export const listSessions = async dir => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const jsonlFiles = entries
    .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
    .map(e => e.name);

  const sessions = await Promise.all(
    jsonlFiles.map(async name => {
      const filePath = path.join(dir, name);
      const sessionId = name.replace(/\.jsonl$/, '');
      const stat = await fs.stat(filePath);
      const meta = await readJsonlMetadata(filePath);
      const title =
        meta.customTitle?.trim()
        || meta.aiTitle?.trim()
        || (meta.firstUserPrompt ? truncate(meta.firstUserPrompt, 60) : '')
        || '(sans titre)';
      return {
        sessionId,
        filePath,
        mtime: stat.mtime,
        firstTimestamp: meta.firstTimestamp ? new Date(meta.firstTimestamp) : stat.mtime,
        title,
        titleSource: meta.customTitle ? 'custom' : meta.aiTitle ? 'ai' : 'prompt',
      };
    }),
  );

  return sessions.toSorted((a, b) => b.mtime - a.mtime);
};
