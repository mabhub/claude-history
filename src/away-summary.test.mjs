import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLatestAwaySummary } from './away-summary.mjs';

const away = content => JSON.stringify({ type: 'system', subtype: 'away_summary', content });
const user = text => JSON.stringify({ type: 'user', message: { content: text } });

/** Write a .jsonl from an array of raw lines. */
const writeJsonl = async lines => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-away-'));
  const filePath = path.join(dir, 'sess.jsonl');
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
};

test('readLatestAwaySummary: returns the content of a single away near the end', async () => {
  const fp = await writeJsonl([user('hi'), away('a summary'), user('bye')]);
  assert.equal(await readLatestAwaySummary(fp), 'a summary');
});

test('readLatestAwaySummary: returns the LAST away when several are scattered', async () => {
  const fp = await writeJsonl([away('old'), user('x'), away('mid'), user('y'), away('latest')]);
  assert.equal(await readLatestAwaySummary(fp), 'latest');
});

test('readLatestAwaySummary: finds an away beyond the first block via growing reads', async () => {
  // Pad so the away sits far from the end, forcing a block enlargement.
  const filler = Array.from({ length: 2000 }, (_, i) => user(`msg ${i} ${'x'.repeat(80)}`));
  const fp = await writeJsonl([away('deep summary'), ...filler]);
  // Tiny first block guarantees the away is past it.
  assert.equal(await readLatestAwaySummary(fp, { maxBytes: 256 }), 'deep summary');
});

test('readLatestAwaySummary: returns null when there is no away', async () => {
  const fp = await writeJsonl([user('hi'), user('bye')]);
  assert.equal(await readLatestAwaySummary(fp), null);
});

test('readLatestAwaySummary: returns null for a missing/unreadable file', async () => {
  assert.equal(await readLatestAwaySummary('/nonexistent/nope.jsonl'), null);
});

test('readLatestAwaySummary: ignores an away entry with empty content', async () => {
  const fp = await writeJsonl([away('real'), user('x'), away('')]);
  assert.equal(await readLatestAwaySummary(fp), 'real');
});
