import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resumeWithChecks, coldResumeWarning } from './resume-flow.mjs';

/** Write a transcript with a recorded cwd that does not exist, under a storage dir. */
const makeMissingCwdTranscript = async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-flow-'));
  const dir = path.join(base, '-gone');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'sess.jsonl');
  await fs.writeFile(filePath, `${JSON.stringify({ type: 'user', cwd: '/nonexistent/ghost/dir' })}\n`, 'utf8');
  return filePath;
};

test('resumeWithChecks: returns "unavailable" without a TTY when the cwd is gone', async () => {
  const filePath = await makeMissingCwdTranscript();
  const savedIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = false;
  try {
    // The 'missing' branch guards on !isTTY and returns before any prompt or
    // spawn, so this exercises the guard without touching resumeSession.
    const outcome = await resumeWithChecks({ sessionId: 'sess', filePath });
    assert.equal(outcome, 'unavailable');
  } finally {
    process.stdin.isTTY = savedIsTTY;
  }
});

test('coldResumeWarning: null while the cache is warm', () => {
  const now = Date.parse('2026-05-01T10:00:00Z');
  assert.equal(coldResumeWarning({ contextTokens: 182000, cacheExpiresAt: new Date('2026-05-01T10:30:00Z') }, now), null);
});

test('coldResumeWarning: says since when the cache expired and what a resume reloads', () => {
  const now = Date.parse('2026-05-01T13:00:00Z');
  const warning = coldResumeWarning({ contextTokens: 182000, cacheExpiresAt: new Date('2026-05-01T10:00:00Z') }, now);
  assert.match(warning, /expiré il y a 3h/);
  assert.match(warning, /182K tok/);
});

test('coldResumeWarning: still warns when the expiry and size are unknown', () => {
  const warning = coldResumeWarning({ contextTokens: null, cacheExpiresAt: null });
  assert.match(warning, /n'est plus en cache/);
  assert.match(warning, /taille inconnue/);
});
