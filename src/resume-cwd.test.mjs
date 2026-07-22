import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeCwd } from './util.mjs';
import { naiveDecode, deduceCwdFromEncoded, resolveCwdState } from './resume-cwd.mjs';

test('naiveDecode: turns every dash into a slash', () => {
  assert.equal(naiveDecode('-home-me-proj'), '/home/me/proj');
});

test('deduceCwdFromEncoded: walks the FS to find the longest real prefix', async () => {
  // Build a real tree: <base>/home/me exists, but /home/me/ghost does not.
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-deduce-'));
  const real = path.join(base, 'home', 'me');
  await fs.mkdir(real, { recursive: true });
  const target = path.join(real, 'ghost'); // does not exist on disk
  const encodedDir = encodeCwd(target);
  const { existingPrefix, missingSuffix, guess } = await deduceCwdFromEncoded(encodedDir, { fsRoot: base });
  assert.equal(existingPrefix, real);
  assert.equal(missingSuffix, 'ghost');
  assert.equal(guess, path.join(real, 'ghost'));
});

test('deduceCwdFromEncoded: follows a symlinked directory segment', async () => {
  // <base>/link -> <base>/realdir ; the cwd's middle segment is the symlink.
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-deduce-'));
  await fs.mkdir(path.join(base, 'realdir'), { recursive: true });
  await fs.symlink(path.join(base, 'realdir'), path.join(base, 'link'));
  const target = path.join(base, 'link', 'ghost'); // link resolves, ghost does not
  const encodedDir = encodeCwd(target);
  const { existingPrefix, missingSuffix } = await deduceCwdFromEncoded(encodedDir, { fsRoot: base });
  assert.equal(existingPrefix, path.join(base, 'link'));
  assert.equal(missingSuffix, 'ghost');
});

test('deduceCwdFromEncoded: whole path missing yields empty prefix and naive guess', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-deduce-'));
  // Nothing under base matches; target is a sibling tree that does not exist.
  const encodedDir = encodeCwd(path.join(base, 'x', 'y'));
  const { existingPrefix } = await deduceCwdFromEncoded(encodedDir, { fsRoot: base });
  assert.equal(existingPrefix, base); // base itself exists, its children don't
});

/** Write a one-line transcript carrying (or not) a cwd, under an encoded dir. */
const makeTranscript = async (encodedName, cwdValue) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-state-'));
  const dir = path.join(base, encodedName);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'sess.jsonl');
  const entry = cwdValue === undefined ? { type: 'user' } : { type: 'user', cwd: cwdValue };
  await fs.writeFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  return { base, filePath };
};

test('resolveCwdState: ok when the recorded cwd exists', async () => {
  const existing = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-live-'));
  const { filePath } = await makeTranscript('-whatever', existing);
  const state = await resolveCwdState(filePath);
  assert.equal(state.status, 'ok');
  assert.equal(state.recordedCwd, existing);
});

test('resolveCwdState: missing when the recorded cwd is gone', async () => {
  const { filePath } = await makeTranscript('-whatever', '/nonexistent/ghost/dir');
  const state = await resolveCwdState(filePath);
  assert.equal(state.status, 'missing');
  assert.equal(state.recordedCwd, '/nonexistent/ghost/dir');
});

test('resolveCwdState: unknown when the transcript has no cwd', async () => {
  const { filePath } = await makeTranscript('-home-me-x', undefined);
  const state = await resolveCwdState(filePath, { fsRoot: '/' });
  assert.equal(state.status, 'unknown');
  assert.equal(state.recordedCwd, null);
  assert.equal(state.encodedDir, '-home-me-x');
  assert.equal(typeof state.guess, 'string');
});
