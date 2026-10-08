import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { projectsDirFor, defaultProjectsRoot, encodeCwd, truncate } from './util.mjs';
import { cleanUserText } from './transcript.mjs';

// Claude Code's own session picker reads the last 64 KB, and it re-appends the
// title/color block only often enough to stay within that window — a single
// turn can push it tens of KB from the end. Reading less misses it.
const TAIL_READ_BYTES = 64 * 1024;
// Only lines holding one of these get JSON-parsed (plus the few trailing ones
// scanned for a timestamp). Claude Code serializes without spaces, and inside a
// message body the quotes would be escaped, so this never skips a real entry.
const TAIL_META_MARKERS = ['"type":"custom-title"', '"type":"ai-title"', '"type":"agent-color"'];
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
 * Search every project directory under `projectsRoot` for sessions whose id
 * starts with `idOrPrefix`. Unlike `resolveId`, this is filesystem-wide: it is
 * the fallback used when an id is not found in the current project. Each match
 * carries its owning project `dir` plus an `encodedDir` label (the on-disk
 * directory name) so callers can tell the user where the session actually lives
 * — we can't reliably decode it back to a real cwd because `encodeCwd` is lossy.
 * @param {string} idOrPrefix - Short prefix (>=4 chars) or full UUID
 * @param {Object} [options]
 * @param {string} [options.projectsRoot] - Override ~/.claude/projects (for tests)
 * @returns {Promise<Array<{sessionId: string, dir: string, encodedDir: string}>>}
 */
export const findSessionGlobally = async (idOrPrefix, { projectsRoot = defaultProjectsRoot() } = {}) => {
  let entries;
  try {
    entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const projectDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  const perProject = await Promise.all(
    projectDirs.map(async encodedDir => {
      const dir = path.join(projectsRoot, encodedDir);
      const ids = await safeListIds(dir);
      return ids
        .filter(id => id.startsWith(idOrPrefix))
        .map(sessionId => ({ sessionId, dir, encodedDir }));
    }),
  );
  return perProject.flat();
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
 * Stream the first HEAD_MAX_LINES parsed entries of a transcript, invoking
 * `onEntry` for each. Return a truthy value from `onEntry` to stop early (once
 * everything of interest has been found), avoiding a full-file read. Unparseable
 * and empty lines are skipped. Shared by every head reader so the streaming,
 * early-stop and cleanup logic lives in one place.
 * @param {string} filePath - Path to the .jsonl file
 * @param {(entry: Object) => boolean|void} onEntry - Called per parsed entry; return true to stop
 * @returns {Promise<void>}
 */
const streamHeadEntries = async (filePath, onEntry) => {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineCount = 0;
  try {
    for await (const line of rl) {
      lineCount += 1;
      if (line) {
        const entry = safeParse(line);
        if (entry && onEntry(entry)) break;
      }
      if (lineCount >= HEAD_MAX_LINES) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
};

/**
 * Read the cwd a conversation was recorded in, from the transcript head. Claude
 * Code stamps the real working directory onto its entries (`"cwd": "…"`), which
 * is the reliable source — unlike the encoded projects-dir name, whose encoding
 * is lossy and can't be decoded back. Returns null if no entry in the head
 * carries a cwd (older or truncated transcripts).
 * @param {string} filePath - Path to the .jsonl file
 * @returns {Promise<string|null>} Absolute cwd, or null if absent
 */
export const readSessionCwd = async filePath => {
  let cwd = null;
  await streamHeadEntries(filePath, entry => {
    if (typeof entry.cwd === 'string' && entry.cwd) {
      cwd = entry.cwd;
      return true;
    }
  });
  return cwd;
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
  await streamHeadEntries(filePath, entry => {
    if (!firstTimestamp && typeof entry.timestamp === 'string') {
      firstTimestamp = entry.timestamp;
    }
    if (!firstUserPrompt && entry.type === 'user') {
      firstUserPrompt = extractUserText(entry);
    }
    return firstTimestamp && firstUserPrompt;
  });
  return { firstTimestamp, firstUserPrompt };
};

/**
 * Read just the first user prompt from a transcript head (no timestamp), for
 * cheap fallback context when no away_summary is available.
 * @param {string} filePath - Path to the .jsonl file
 * @returns {Promise<string|null>} First user prompt text, or null
 */
export const readFirstUserPrompt = async filePath => {
  let prompt = null;
  await streamHeadEntries(filePath, entry => {
    if (entry.type === 'user') {
      prompt = extractUserText(entry);
      return true;
    }
  });
  return prompt;
};

/**
 * Read the tail of a .jsonl transcript (last TAIL_READ_BYTES) and extract the
 * latest custom-title / ai-title / agent-color entries, which Claude Code
 * periodically re-appends together near the end of the file.
 * Also returns the latest entry `timestamp`: those metadata entries carry none,
 * so it dates the last real activity even when they were written hours later.
 * Lines are scanned from the end, so the first match of each kind is the latest
 * and the scan stops once all four are known.
 * @param {string} filePath - Path to the .jsonl file
 * @param {number} fileSize - Total file size in bytes
 * @returns {Promise<{customTitle: string|null, aiTitle: string|null, agentColor: string|null, lastTimestamp: string|null}>}
 */
const readTailMeta = async (filePath, fileSize) => {
  const meta = { customTitle: null, aiTitle: null, agentColor: null, lastTimestamp: null };
  const readSize = Math.min(TAIL_READ_BYTES, fileSize);
  if (readSize === 0) return meta;

  const fh = await fs.open(filePath, 'r');
  let text;
  try {
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, fileSize - readSize);
    text = buf.toString('utf8');
  } finally {
    await fh.close();
  }
  const lines = text.split('\n');
  // Drop partial first line if we started mid-line.
  if (fileSize > readSize) lines.shift();
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const needsTimestamp = meta.lastTimestamp === null;
    if (!line || (!needsTimestamp && !TAIL_META_MARKERS.some(marker => line.includes(marker)))) continue;
    const entry = safeParse(line);
    if (!entry) continue;
    if (needsTimestamp && typeof entry.timestamp === 'string') meta.lastTimestamp = entry.timestamp;
    if (entry.type === 'custom-title' && meta.customTitle === null && typeof entry.customTitle === 'string') {
      meta.customTitle = entry.customTitle;
    } else if (entry.type === 'ai-title' && meta.aiTitle === null && typeof entry.aiTitle === 'string') {
      meta.aiTitle = entry.aiTitle;
    } else if (entry.type === 'agent-color' && meta.agentColor === null && typeof entry.agentColor === 'string') {
      meta.agentColor = entry.agentColor;
    }
    if (Object.values(meta).every(value => value !== null)) break;
  }
  return meta;
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
 * @returns {Promise<Array<Object>>} Sessions sorted by lastActivity desc
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
      readTailMeta(filePath, stat.size),
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
      lastActivity: parseDate(tail.lastTimestamp) ?? stat.mtime,
      size: stat.size,
      firstTimestamp: head.firstTimestamp ? new Date(head.firstTimestamp) : stat.mtime,
      title,
      titleSource: tail.customTitle ? 'custom' : tail.aiTitle ? 'ai' : 'prompt',
      color: tail.agentColor,
    };
  });

  return sessions.toSorted((a, b) => b.lastActivity - a.lastActivity);
};

/**
 * Parse an ISO timestamp, or return null when absent or invalid.
 * @param {string|null} iso - Timestamp string
 * @returns {Date|null}
 */
const parseDate = iso => {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
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
