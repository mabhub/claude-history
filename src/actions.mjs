import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

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
 * @param {Object} options
 * @param {string} options.filePath - Path to the .jsonl transcript
 * @param {string} options.sessionId - Full session UUID
 * @returns {Promise<{removedDir: boolean}>}
 */
export const deleteSession = async ({ filePath, sessionId }) => {
  await fs.unlink(filePath);
  const companionDir = path.join(path.dirname(filePath), sessionId);
  let removedDir = false;
  try {
    await fs.rm(companionDir, { recursive: true, force: true });
    removedDir = true;
  } catch {
    removedDir = false;
  }
  return { removedDir };
};

/**
 * Spawn `claude --resume <sessionId>` with inherited stdio, then exit with
 * the child's exit code.
 * @param {string} sessionId - Full session UUID
 * @returns {Promise<never>} Process exits before resolving
 */
export const resumeSession = sessionId =>
  new Promise((_resolve, reject) => {
    const child = spawn('claude', ['--resume', sessionId], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => process.exit(code ?? 0));
  });
