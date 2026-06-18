import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { projectsDirFor, defaultProjectsRoot, encodeCwd, truncate } from './util.mjs';
import { cleanUserText } from './transcript.mjs';

const TAIL_READ_BYTES = 8 * 1024;
const HEAD_MAX_LINES = 50;

/**
 * Walk up from `startCwd` until we find a Claude projects directory that
 * contains at least one .jsonl file, or until we hit the filesystem root.
 * The returned `cwd` is the (possibly missing) path that owns the transcripts —
 * callers can probe it with `pathExists` if they need to flag it as deleted.
 * Unlike `findSubProjects` / `findParentProjects`, there's no `displayLabel`
 * in the return shape: callers always start from a known real `cwd` here.
 * @param {string} startCwd - Absolute path to start from
 * @param {Object} [options]
 * @param {string} [options.projectsRoot] - Override ~/.claude/projects (for tests)
 * @returns {Promise<{dir: string|null, cwd: string|null, walkedUp: boolean}>}
 */
export const findProjectDir = async (startCwd, { projectsRoot = defaultProjectsRoot() } = {}) => {
  let current = path.resolve(startCwd);
  const original = current;
  while (true) {
    const dir = projectsDirFor(current, projectsRoot);
    if (await dirContainsJsonl(dir)) {
      return { dir, cwd: current, walkedUp: current !== original };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return { dir: null, cwd: null, walkedUp: false };
    }
    current = parent;
  }
};

/**
 * Check whether a filesystem path exists (any kind).
 * @param {string} p - Absolute path
 * @returns {Promise<boolean>}
 */
export const pathExists = async p => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
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
 * Find sub-projects of `cwd`: descendant directories that also have a Claude
 * Code transcript folder. Uses the encoded-prefix scan under `projectsRoot`,
 * then resolves each candidate back to a real path by walking the local FS.
 * Encoded dirs with no matching real path are still returned with `cwd: null`
 * and `missing: true` — their `displayLabel` falls back to the encoded name
 * so the user can still see the orphan and inspect its transcripts.
 * @param {string} cwd - Absolute path to scan from
 * @param {Object} [options]
 * @param {string} [options.projectsRoot] - Override ~/.claude/projects (for tests)
 * @returns {Promise<Array<{cwd: string|null, displayLabel: string, dir: string, sessionCount: number, missing: boolean}>>}
 */
export const findSubProjects = async (cwd, { projectsRoot = defaultProjectsRoot() } = {}) => {
  const prefix = `${encodeCwd(cwd)}-`;
  let candidates;
  try {
    candidates = await fs.readdir(projectsRoot);
  } catch {
    return [];
  }
  const matching = candidates.filter(name => name.startsWith(prefix));
  if (matching.length === 0) return [];

  // Build a map of every encoded(real-subdir-path) -> real path, by walking
  // the local FS one level at a time. We only go deep enough to cover the
  // longest matching candidate, and we stop a branch as soon as no candidate
  // could still match its prefix.
  const realPaths = await collectMatchingSubpaths(cwd, matching);
  const matchedEncoded = new Set(Array.from(realPaths, encodeCwd));

  const real = await Promise.all(
    Array.from(realPaths).map(async realCwd => {
      const dir = projectsDirFor(realCwd, projectsRoot);
      const ids = await safeListIds(dir);
      return {
        cwd: realCwd,
        displayLabel: realCwd,
        dir,
        sessionCount: ids.length,
        missing: false,
      };
    }),
  );

  const orphans = await Promise.all(
    matching
      .filter(name => !matchedEncoded.has(name))
      .map(async name => {
        const dir = path.join(projectsRoot, name);
        const ids = await safeListIds(dir);
        return {
          cwd: null,
          displayLabel: name,
          dir,
          sessionCount: ids.length,
          missing: true,
        };
      }),
  );

  return [...real, ...orphans]
    .filter(s => s.sessionCount > 0)
    .toSorted((a, b) => a.displayLabel.localeCompare(b.displayLabel));
};

/**
 * Walk the FS under `rootCwd`, returning every descendant whose encoded form
 * appears in `wantedEncoded`. Prunes branches that cannot match any candidate.
 * @param {string} rootCwd - Local root to walk
 * @param {Array<string>} wantedEncoded - Encoded project-dir names to match
 * @returns {Promise<Set<string>>} Real absolute paths
 */
const collectMatchingSubpaths = async (rootCwd, wantedEncoded) => {
  const wanted = new Set(wantedEncoded);
  const found = new Set();
  const visit = async dir => {
    let children;
    try {
      children = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (!child.isDirectory() || child.name.startsWith('.')) continue;
      const childPath = path.join(dir, child.name);
      const encoded = encodeCwd(childPath);
      if (wanted.has(encoded)) found.add(childPath);
      // Recurse only if at least one candidate still starts with this prefix.
      const prefix = `${encoded}-`;
      const shouldRecurse = Array.from(wanted).some(w => w.startsWith(prefix));
      if (shouldRecurse) await visit(childPath);
    }
  };
  await visit(rootCwd);
  return found;
};

const safeListIds = async dir => {
  try {
    return await listSessionIds(dir);
  } catch {
    return [];
  }
};

/**
 * Find ancestor directories of `cwd` that have their own Claude Code
 * transcripts. Walks up to the filesystem root, returning every parent
 * with at least one .jsonl file (excluding `cwd` itself).
 * @param {string} cwd - Absolute path to start from
 * @param {Object} [options]
 * @param {string} [options.projectsRoot] - Override ~/.claude/projects (for tests)
 * @returns {Promise<Array<{cwd: string, displayLabel: string, dir: string, sessionCount: number, missing: boolean}>>}
 */
export const findParentProjects = async (cwd, { projectsRoot = defaultProjectsRoot() } = {}) => {
  const parents = [];
  let current = path.dirname(path.resolve(cwd));
  while (true) {
    const dir = projectsDirFor(current, projectsRoot);
    const ids = await safeListIds(dir);
    if (ids.length > 0) {
      const missing = !(await pathExists(current));
      parents.push({
        cwd: current,
        displayLabel: current,
        dir,
        sessionCount: ids.length,
        missing,
      });
    }
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return parents;
};

/**
 * Cheap listing of session ids in a directory (no JSONL parsing).
 * Use this when you only need to resolve an id prefix or check existence.
 * @param {string} dir - Claude projects directory
 * @returns {Promise<Array<string>>} Full session UUIDs
 */
export const listSessionIds = async dir => {
  const entries = await fs.readdir(dir);
  return entries
    .filter(name => name.endsWith('.jsonl'))
    .map(name => name.replace(/\.jsonl$/, ''));
};

/**
 * Read the head of a .jsonl transcript (first timestamp + first user prompt),
 * stopping as soon as both are found or HEAD_MAX_LINES is reached.
 * @param {string} filePath - Path to the .jsonl file
 * @returns {Promise<{firstTimestamp: string|null, firstUserPrompt: string|null}>}
 */
const readHead = async filePath => {
  let firstTimestamp = null;
  let firstUserPrompt = null;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineCount = 0;
  try {
    for await (const line of rl) {
      lineCount += 1;
      if (line) {
        const entry = safeParse(line);
        if (entry) {
          if (!firstTimestamp && typeof entry.timestamp === 'string') {
            firstTimestamp = entry.timestamp;
          }
          if (!firstUserPrompt && entry.type === 'user') {
            firstUserPrompt = extractUserText(entry);
          }
        }
      }
      if ((firstTimestamp && firstUserPrompt) || lineCount >= HEAD_MAX_LINES) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { firstTimestamp, firstUserPrompt };
};

/**
 * Read the tail of a .jsonl transcript (last TAIL_READ_BYTES) and extract the
 * latest custom-title / ai-title entries — both are always appended at the end
 * of the file by Claude Code.
 * @param {string} filePath - Path to the .jsonl file
 * @param {number} fileSize - Total file size in bytes
 * @returns {Promise<{customTitle: string|null, aiTitle: string|null}>}
 */
const readTailTitles = async (filePath, fileSize) => {
  let customTitle = null;
  let aiTitle = null;
  const readSize = Math.min(TAIL_READ_BYTES, fileSize);
  if (readSize === 0) return { customTitle, aiTitle };

  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, fileSize - readSize);
    const text = buf.toString('utf8');
    // Drop partial first line if we started mid-line.
    const lines = text.split('\n');
    if (fileSize > readSize) lines.shift();
    for (const line of lines) {
      if (!line) continue;
      const entry = safeParse(line);
      if (!entry) continue;
      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
        customTitle = entry.customTitle;
      } else if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') {
        aiTitle = entry.aiTitle;
      }
    }
  } finally {
    await fh.close();
  }
  return { customTitle, aiTitle };
};

const safeParse = line => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
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
 * List all conversations in a Claude projects directory, with full metadata.
 * Head and tail of each file are read separately to avoid parsing the full
 * (potentially multi-MB) transcripts.
 * @param {string} dir - Directory containing .jsonl transcripts
 * @returns {Promise<Array<Object>>} Sessions sorted by mtime desc
 */
export const listSessions = async dir => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const jsonlFiles = entries
    .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
    .map(e => e.name);

  const sessions = await mapWithConcurrency(jsonlFiles, 16, async name => {
    const filePath = path.join(dir, name);
    const sessionId = name.replace(/\.jsonl$/, '');
    const stat = await fs.stat(filePath);
    const [head, tail] = await Promise.all([
      readHead(filePath),
      readTailTitles(filePath, stat.size),
    ]);
    const cleanedPrompt = head.firstUserPrompt ? cleanUserText(head.firstUserPrompt) : '';
    const title =
      tail.customTitle?.trim()
      || tail.aiTitle?.trim()
      || (cleanedPrompt ? truncate(cleanedPrompt, 60) : '')
      || '(sans titre)';
    return {
      sessionId,
      filePath,
      mtime: stat.mtime,
      firstTimestamp: head.firstTimestamp ? new Date(head.firstTimestamp) : stat.mtime,
      title,
      titleSource: tail.customTitle ? 'custom' : tail.aiTitle ? 'ai' : 'prompt',
    };
  });

  return sessions.toSorted((a, b) => b.mtime - a.mtime);
};

/**
 * Run an async mapper over an array with a max concurrency.
 * Avoids opening unbounded file descriptors on large directories.
 * @template T, U
 * @param {Array<T>} items - Input items
 * @param {number} limit - Maximum concurrent in-flight tasks
 * @param {(item: T) => Promise<U>} fn - Async mapper
 * @returns {Promise<Array<U>>} Results in input order
 */
const mapWithConcurrency = async (items, limit, fn) => {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
};
