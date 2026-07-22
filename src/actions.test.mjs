import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renameSession, deleteSession } from './actions.mjs';

const mkTmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'clh-actions-'));

test('renameSession: appends a custom-title entry', async () => {
  const dir = await mkTmp();
  const filePath = path.join(dir, 'abc.jsonl');
  await fs.writeFile(filePath, '{"type":"user"}\n', 'utf8');
  await renameSession({ filePath, sessionId: 'abc', title: '  hello  ' });
  const lines = (await fs.readFile(filePath, 'utf8')).trim().split('\n');
  const last = JSON.parse(lines.at(-1));
  assert.deepEqual(last, { type: 'custom-title', customTitle: 'hello', sessionId: 'abc' });
});

test('renameSession: rejects an empty title', async () => {
  const dir = await mkTmp();
  const filePath = path.join(dir, 'abc.jsonl');
  await fs.writeFile(filePath, '', 'utf8');
  await assert.rejects(
    renameSession({ filePath, sessionId: 'abc', title: '   ' }),
    /Title cannot be empty/,
  );
});

test('deleteSession: reports removedDir=true when a companion dir existed', async () => {
  const dir = await mkTmp();
  const filePath = path.join(dir, 'abc.jsonl');
  await fs.writeFile(filePath, '{}\n', 'utf8');
  await fs.mkdir(path.join(dir, 'abc'));
  const { removedDir } = await deleteSession({ filePath, sessionId: 'abc' });
  assert.equal(removedDir, true);
  assert.equal(await exists(filePath), false);
  assert.equal(await exists(path.join(dir, 'abc')), false);
});

test('deleteSession: reports removedDir=false when there was no companion dir', async () => {
  const dir = await mkTmp();
  const filePath = path.join(dir, 'abc.jsonl');
  await fs.writeFile(filePath, '{}\n', 'utf8');
  const { removedDir } = await deleteSession({ filePath, sessionId: 'abc' });
  assert.equal(removedDir, false);
  assert.equal(await exists(filePath), false);
});

/** Whether a path exists on disk. */
const exists = async p => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};
