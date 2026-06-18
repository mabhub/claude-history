import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalize,
  dedupe,
  bucketOf,
  summarize,
  timeseriesLong,
  timeseriesPivot,
  successBreakdown,
  cooccurrence,
  filterEvents,
  extractEventsFromFile,
} from './skills.mjs';

// --- canonicalize -----------------------------------------------------------

test('canonicalize: strips plugin namespace', () => {
  assert.deepEqual(canonicalize('superpowers:brainstorming'), { skill: 'brainstorming', namespace: 'superpowers' });
});

test('canonicalize: unprefixed name is builtin', () => {
  assert.deepEqual(canonicalize('git-commit-messages'), { skill: 'git-commit-messages', namespace: 'builtin' });
});

// --- bucketOf ---------------------------------------------------------------

test('bucketOf: day/month slice the ISO string', () => {
  assert.equal(bucketOf('2026-06-18T22:14:03.000Z', 'day'), '2026-06-18');
  assert.equal(bucketOf('2026-06-18T22:14:03.000Z', 'month'), '2026-06');
});

test('bucketOf: week returns ISO week', () => {
  assert.equal(bucketOf('2026-06-18T00:00:00.000Z', 'week'), '2026-W25');
});

test('bucketOf: null timestamp bucketed as unknown', () => {
  assert.equal(bucketOf(null, 'day'), 'unknown');
});

// --- dedupe: the tool+slash double-logging trap -----------------------------

const ev = (over = {}) => ({
  skill: 'brainstorming', skillRaw: 'superpowers:brainstorming', namespace: 'superpowers',
  ts: '2026-06-01T10:00:00.000Z', session: 's1', project: 'p', channel: 'tool',
  agent: 'main', caller: 'direct', status: 'success', errorKind: null, ...over,
});

test('dedupe: a tool event and its slash twin collapse to one', () => {
  const events = [
    ev({ channel: 'tool', ts: '2026-06-01T10:00:00.000Z' }),
    ev({ channel: 'slash', ts: '2026-06-01T10:00:02.000Z', caller: null }),
  ];
  const out = dedupe(events);
  assert.equal(out.length, 1);
  assert.equal(out[0].channel, 'tool');
  assert.equal(out[0].bothChannels, true);
});

test('dedupe: a lone slash event (user-typed /skill) survives', () => {
  const events = [ev({ channel: 'slash', skill: 'code-review', caller: null })];
  const out = dedupe(events);
  assert.equal(out.length, 1);
  assert.equal(out[0].channel, 'slash');
});

test('dedupe: slash event outside the time window is NOT collapsed', () => {
  const events = [
    ev({ channel: 'tool', ts: '2026-06-01T10:00:00.000Z' }),
    ev({ channel: 'slash', ts: '2026-06-01T10:05:00.000Z', caller: null }),
  ];
  assert.equal(dedupe(events).length, 2);
});

test('dedupe: two real activations each keep their slash twin', () => {
  const events = [
    ev({ channel: 'tool', ts: '2026-06-01T10:00:00.000Z' }),
    ev({ channel: 'slash', ts: '2026-06-01T10:00:01.000Z', caller: null }),
    ev({ channel: 'tool', ts: '2026-06-01T11:00:00.000Z' }),
    ev({ channel: 'slash', ts: '2026-06-01T11:00:01.000Z', caller: null }),
  ];
  // 2 tool + 2 slash twins -> 2 surviving tool events
  assert.equal(dedupe(events).length, 2);
});

test('dedupe: does not mutate its input events (bothChannels stays off the originals)', () => {
  const input = [
    ev({ channel: 'tool', ts: '2026-06-01T10:00:00.000Z' }),
    ev({ channel: 'slash', ts: '2026-06-01T10:00:02.000Z', caller: null }),
  ];
  const out = dedupe(input);
  // The surviving tool event carries the tag…
  assert.equal(out[0].bothChannels, true);
  // …but the original input objects are untouched (no leaked tag, no work flag).
  for (const e of input) {
    assert.equal('bothChannels' in e, false);
    assert.equal('_matched' in e, false);
  }
});

// --- aggregations -----------------------------------------------------------

test('summarize: groups on canonical skill, counts channels and subagents', () => {
  const events = [
    ev({ channel: 'tool', session: 's1' }),
    ev({ channel: 'slash', session: 's2', caller: null }),
    ev({ channel: 'tool', session: 's1', agent: 'subagent' }),
  ];
  const [row] = summarize(events);
  assert.equal(row.skill, 'brainstorming');
  assert.equal(row.count, 3);
  assert.equal(row.sessions, 2);
  assert.equal(row.tool, 2);
  assert.equal(row.slash, 1);
  assert.equal(row.subagent, 1);
});

test('timeseriesLong: one row per (period, skill)', () => {
  const events = [
    ev({ ts: '2026-05-10T00:00:00Z' }),
    ev({ ts: '2026-05-20T00:00:00Z' }),
    ev({ ts: '2026-06-01T00:00:00Z', skill: 'glab-cli' }),
  ];
  const rows = timeseriesLong(events, 'month');
  assert.deepEqual(rows, [
    { period: '2026-05', skill: 'brainstorming', count: 2 },
    { period: '2026-06', skill: 'glab-cli', count: 1 },
  ]);
});

test('timeseriesPivot: zero-fills the matrix', () => {
  const events = [
    ev({ ts: '2026-05-10T00:00:00Z', skill: 'a' }),
    ev({ ts: '2026-06-10T00:00:00Z', skill: 'b' }),
  ];
  const { periods, skills, rows } = timeseriesPivot(events, 'month');
  assert.deepEqual(periods, ['2026-05', '2026-06']);
  assert.equal(skills.length, 2);
  // every row has a count per skill, zero where absent
  assert.equal(rows[0].counts.length, 2);
  assert.equal(rows[0].counts.reduce((a, b) => a + b), 1);
});

test('successBreakdown: surfaces unknown-skill failures', () => {
  const events = [
    ev({ status: 'success' }),
    ev({ skill: 'commit', skillRaw: 'commit', namespace: 'builtin', status: 'error', errorKind: 'unknown-skill' }),
  ];
  const { unknownSkills } = successBreakdown(events);
  assert.deepEqual(unknownSkills, [{ skill: 'commit', count: 1 }]);
});

test('cooccurrence: pairs skills sharing a session', () => {
  const events = [
    ev({ skill: 'brainstorming', session: 's1' }),
    ev({ skill: 'writing-plans', session: 's1' }),
    ev({ skill: 'glab-cli', session: 's2' }),
  ];
  const pairs = cooccurrence(events);
  assert.deepEqual(pairs, [{ a: 'brainstorming', b: 'writing-plans', sessions: 1 }]);
});

test('filterEvents: channel and date bounds combine with AND', () => {
  const events = [
    ev({ channel: 'tool', ts: '2026-05-01T00:00:00Z' }),
    ev({ channel: 'slash', ts: '2026-06-01T00:00:00Z', caller: null }),
  ];
  assert.equal(filterEvents(events, { channel: 'tool' }).length, 1);
  assert.equal(filterEvents(events, { since: '2026-05-15' }).length, 1);
  assert.equal(filterEvents(events, { skill: /brain/ }).length, 2);
});

// --- extractEventsFromFile (integration over a synthetic transcript) --------

test('extractEventsFromFile: parses tool success, tool error and slash', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-skills-'));
  const file = path.join(dir, 'sess.jsonl');
  const lines = [
    // tool_use success + its result
    { timestamp: '2026-06-01T10:00:00Z', sessionId: 's1', message: { content: [
      { type: 'tool_use', id: 'a1', name: 'Skill', input: { skill: 'superpowers:brainstorming' }, caller: { type: 'direct' } },
    ] } },
    { timestamp: '2026-06-01T10:00:00Z', sessionId: 's1', message: { content: [
      { type: 'tool_result', tool_use_id: 'a1', is_error: false, content: 'Launching skill: superpowers:brainstorming' },
    ] } },
    // tool_use failure (unknown skill)
    { timestamp: '2026-06-01T10:01:00Z', sessionId: 's1', message: { content: [
      { type: 'tool_use', id: 'a2', name: 'Skill', input: { skill: 'commit' }, caller: { type: 'direct' } },
    ] } },
    { timestamp: '2026-06-01T10:01:00Z', sessionId: 's1', message: { content: [
      { type: 'tool_result', tool_use_id: 'a2', is_error: true, content: '<tool_use_error>Unknown skill: commit</tool_use_error>' },
    ] } },
    // slash expansion (user-typed) for a different skill, no tool twin
    { timestamp: '2026-06-01T10:02:00Z', sessionId: 's1', message: { content: [
      { type: 'text', text: 'Base directory for this skill: /home/u/.claude/skills/code-review\n# Code Review' },
    ] } },
  ];
  await fs.writeFile(file, lines.map(l => JSON.stringify(l)).join('\n'), 'utf8');

  const events = await extractEventsFromFile(file, 'proj', 'main');
  await fs.rm(dir, { recursive: true, force: true });

  const bySkill = Object.fromEntries(events.map(e => [e.skill, e]));
  assert.equal(events.length, 3);
  assert.equal(bySkill.brainstorming.status, 'success');
  assert.equal(bySkill.brainstorming.namespace, 'superpowers');
  assert.equal(bySkill.commit.status, 'error');
  assert.equal(bySkill.commit.errorKind, 'unknown-skill');
  assert.equal(bySkill['code-review'].channel, 'slash');
});
