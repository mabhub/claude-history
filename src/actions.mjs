import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readSessionCwd, pathExists } from './discover.mjs';

/**
 * Append a custom-title entry to the session's .jsonl file.
 * Mirrors what Claude Code's /rename command does internally.
 * @param {Object} options
 * @param {string} options.filePath - Path to the .jsonl transcript
 * @param {string} options.sessionId - Full session UUID
 * @param {string} options.title - New title
 * @returns {Promise<void>}
 */
export const renameSession = async ({ filePath, sessionId, title }) => {
  const trimmed = title.trim();
  if (!trimmed) throw new Error('Title cannot be empty.');
  const entry = JSON.stringify({
    type: 'custom-title',
    customTitle: trimmed,
    sessionId,
  });
  await fs.appendFile(filePath, `${entry}\n`, 'utf8');
};

/**
 * Delete a session's .jsonl file and its companion directory (if any).
 * `removedDir` reflects whether a companion directory actually existed and was
 * removed — it stays false when there was none, so callers don't claim to have
 * deleted a directory that never existed.
 * @param {Object} options
 * @param {string} options.filePath - Path to the .jsonl transcript
 * @param {string} options.sessionId - Full session UUID
 * @returns {Promise<{removedDir: boolean}>}
 */
export const deleteSession = async ({ filePath, sessionId }) => {
  await fs.unlink(filePath);
  const companionDir = path.join(path.dirname(filePath), sessionId);
  try {
    // `force: false` (default) makes rm reject with ENOENT when the companion
    // dir is absent, letting us report an honest `removedDir`. Any other error
    // (e.g. EACCES) is a real failure and propagates.
    await fs.rm(companionDir, { recursive: true });
    return { removedDir: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { removedDir: false };
    throw err;
  }
};

/**
 * Spawn `claude --resume <sessionId>` with inherited stdio, then exit with
 * the child's exit code. Runs the child in the conversation's own working
 * directory (read from the transcript) rather than wherever `clh` was invoked
 * — Claude Code resolves a session id against the cwd, so resuming a sub-folder
 * or cross-project session from elsewhere would otherwise fail to find it.
 *
 * The recorded cwd may no longer exist (deleted/moved project). In that case we
 * fall back to the current directory rather than passing a missing cwd to
 * spawn, which would fail with a misleading `spawn claude ENOENT` — making it
 * look like the `claude` binary is missing when it's the old cwd that's gone.
 * @param {Object} options
 * @param {string} options.sessionId - Full session UUID
 * @param {string} options.filePath - Path to the session's .jsonl transcript
 * @returns {Promise<never>} Process exits before resolving
 */
export const resumeSession = async ({ sessionId, filePath }) => {
  // Tolerate a transcript that vanished between listing and resume (race): a
  // null cwd just means "resume from the current directory".
  const recordedCwd = await readSessionCwd(filePath).catch(() => null);
  const cwd = recordedCwd && (await pathExists(recordedCwd)) ? recordedCwd : null;
  return new Promise((_resolve, reject) => {
    const options = { stdio: 'inherit' };
    if (cwd) options.cwd = cwd;
    const child = spawn('claude', ['--resume', sessionId], options);
    child.on('error', reject);
    child.on('exit', code => process.exit(code ?? 0));
  });
};
