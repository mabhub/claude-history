import fs from 'node:fs/promises';

// Growing tail windows (bytes). Start small — the latest away is usually within
// a few KB of the end — and enlarge until found or the whole file is read.
const BLOCK_SIZES = [64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024];

/**
 * Parse one JSONL line, returning the object or null on any error.
 * @param {string} line
 * @returns {Object|null}
 */
const safeParse = line => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/**
 * Scan the tail of `text` (already the last `readSize` bytes of a file of
 * `fileSize` bytes) from the end for the most recent away_summary content.
 * @param {string} text - Decoded tail chunk
 * @param {number} readSize - Bytes this chunk represents
 * @param {number} fileSize - Total file size
 * @returns {string|null}
 */
const findLatestInChunk = (text, readSize, fileSize) => {
  const lines = text.split('\n');
  // Drop the partial first line unless the chunk covers the whole file.
  if (readSize < fileSize) lines.shift();
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    const entry = safeParse(line);
    if (
      entry
      && entry.type === 'system'
      && entry.subtype === 'away_summary'
      && typeof entry.content === 'string'
      && entry.content
    ) {
      return entry.content;
    }
  }
  return null;
};

/**
 * Read the most recent away_summary content from a transcript, scanning from
 * the end in growing windows so a nearby away is found cheaply while a distant
 * one is still reached. Returns null when the transcript has no away_summary or
 * cannot be read. Never called by the listing path — this is a per-session,
 * on-demand read.
 * @param {string} filePath - Path to the .jsonl transcript
 * @param {Object} [options]
 * @param {number} [options.maxBytes] - Override the first window size (for tests)
 * @returns {Promise<string|null>}
 */
export const readLatestAwaySummary = async (filePath, { maxBytes } = {}) => {
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return null;
    // Candidate windows in growing order, plus the whole file as a final net so
    // a very distant away (past the largest BLOCK_SIZE) is still reached.
    const windows = [...(maxBytes ? [maxBytes] : []), ...BLOCK_SIZES, size];
    let lastReadSize = 0;
    for (const window of windows) {
      const readSize = Math.min(window, size);
      if (readSize <= lastReadSize) continue; // no new bytes since last window
      lastReadSize = readSize;
      const buf = Buffer.alloc(readSize);
      await fh.read(buf, 0, readSize, size - readSize);
      const found = findLatestInChunk(buf.toString('utf8'), readSize, size);
      if (found !== null) return found;
      if (readSize >= size) break; // whole file scanned
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
};
