import fs from 'node:fs/promises';
import path from 'node:path';
import { encodeCwd } from './util.mjs';

/**
 * Whether a directory entry is (or points to) a directory. Plain dirs are
 * settled from the Dirent; symlinks are followed with stat, since a cwd
 * segment may legitimately be a symlink to a directory.
 * @param {string} fullPath - Absolute path to the entry
 * @param {import('node:fs').Dirent} dirent - Entry from readdir withFileTypes
 * @returns {Promise<boolean>}
 */
const isDir = async (fullPath, dirent) => {
  if (dirent.isDirectory()) return true;
  if (!dirent.isSymbolicLink()) return false;
  try {
    return (await fs.stat(fullPath)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Naive inverse of encodeCwd: replace every '-' with '/'. Lossy and unreliable
 * on its own (encodeCwd collapses every non-alphanumeric char to '-'), so this
 * is only ever a default value the user confirms or corrects.
 * @param {string} encoded - Encoded directory name
 * @returns {string} A plausible path
 */
export const naiveDecode = encoded => encoded.replaceAll('-', '/');

/**
 * Reconstruct the longest real prefix of the cwd behind an encoded storage dir
 * by walking the filesystem: at each level, pick the existing child directory
 * whose encodeCwd is a prefix of `encodedDir`. Stops at the first missing
 * segment. The unresolved remainder is ambiguous (dashes may be '/' or literal
 * separators), so it is returned raw and also folded into a naive `guess`.
 * @param {string} encodedDir - Storage directory name (e.g. "-home-me-ghost")
 * @param {Object} [options]
 * @param {string} [options.fsRoot='/'] - Root to walk from (injectable for tests)
 * @returns {Promise<{existingPrefix: string, missingSuffix: string, guess: string}>}
 */
export const deduceCwdFromEncoded = async (encodedDir, { fsRoot = '/' } = {}) => {
  let current = fsRoot;
  // Walk down as long as some existing child's encoding still prefixes the target.
  while (true) {
    let children;
    try {
      children = await fs.readdir(current, { withFileTypes: true });
    } catch {
      break;
    }
    // Sort by name so the walk is deterministic when two entries collide after
    // encoding (e.g. a "a/b" tree next to a literal "a-b" dir both encode alike).
    const candidates = children
      .filter(c => !c.name.startsWith('.'))
      .toSorted((a, b) => a.name.localeCompare(b.name));
    let next = null;
    for (const child of candidates) {
      const childEncoded = encodeCwd(path.join(current, child.name));
      if (childEncoded !== encodedDir && !encodedDir.startsWith(`${childEncoded}-`)) continue;
      // A cwd segment can be a symlink to a directory; readdir types it as a
      // symlink, so confirm the resolved target is a directory (stat follows
      // the link) before descending into it.
      if (await isDir(path.join(current, child.name), child)) {
        next = child;
        break;
      }
    }
    if (!next) break;
    current = path.join(current, next.name);
    if (encodeCwd(current) === encodedDir) break;
  }
  const existingPrefix = current;
  const consumedEncoded = encodeCwd(existingPrefix);
  // Remainder of the encoded name past the resolved prefix (drop the joining '-').
  const rest = encodedDir.startsWith(`${consumedEncoded}-`)
    ? encodedDir.slice(consumedEncoded.length + 1)
    : '';
  const missingSuffix = rest;
  const guess = rest ? path.join(existingPrefix, naiveDecode(rest)) : existingPrefix;
  return { existingPrefix, missingSuffix, guess };
};
