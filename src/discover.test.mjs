import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathExists } from './discover.mjs';

test('pathExists: true for a real directory', async () => {
  assert.equal(await pathExists(os.tmpdir()), true);
});

test('pathExists: false for a missing path', async () => {
  const ghost = path.join(os.tmpdir(), `clh-ghost-${Date.now()}-${Math.random()}`);
  assert.equal(await pathExists(ghost), false);
});

test('pathExists: true for a file (not just dirs)', async () => {
  const file = path.join(os.tmpdir(), `clh-probe-${Date.now()}`);
  await fs.writeFile(file, '');
  try {
    assert.equal(await pathExists(file), true);
  } finally {
    await fs.unlink(file);
  }
});
