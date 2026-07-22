import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeCwd } from './util.mjs';
import { naiveDecode, deduceCwdFromEncoded } from './resume-cwd.mjs';

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
