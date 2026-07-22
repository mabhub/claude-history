import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resumeWithCwdCheck } from './resume-flow.mjs';

/** Write a transcript with a recorded cwd that does not exist, under a storage dir. */
const makeMissingCwdTranscript = async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-flow-'));
  const dir = path.join(base, '-gone');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'sess.jsonl');
  await fs.writeFile(filePath, `${JSON.stringify({ type: 'user', cwd: '/nonexistent/ghost/dir' })}\n`, 'utf8');
  return filePath;
};

test('resumeWithCwdCheck: returns "unavailable" without a TTY when the cwd is gone', async () => {
  const filePath = await makeMissingCwdTranscript();
  const savedIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = false;
  try {
    // The 'missing' branch guards on !isTTY and returns before any prompt or
    // spawn, so this exercises the guard without touching resumeSession.
    const outcome = await resumeWithCwdCheck({ sessionId: 'sess', filePath });
    assert.equal(outcome, 'unavailable');
  } finally {
    process.stdin.isTTY = savedIsTTY;
  }
});
