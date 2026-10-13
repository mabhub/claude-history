import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathExists, findSubProjects, findParentProjects, findSessionGlobally, readSessionCwd, readFirstUserPrompt, listSessions } from './discover.mjs';
import { encodeCwd } from './util.mjs';
import { setSessionColor, renameSession } from './actions.mjs';

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

test('readSessionCwd: reads the cwd stamped on the first entry that carries it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-cwd-'));
  const filePath = path.join(dir, 'abc.jsonl');
  // First line has no cwd (mirrors real transcripts starting with last-prompt).
  await fs.writeFile(
    filePath,
    '{"type":"last-prompt"}\n{"type":"user","cwd":"/home/me/project"}\n',
    'utf8',
  );
  assert.equal(await readSessionCwd(filePath), '/home/me/project');
});

test('readSessionCwd: returns null when no head entry carries a cwd', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-cwd-'));
  const filePath = path.join(dir, 'abc.jsonl');
  await fs.writeFile(filePath, '{"type":"user"}\n{"type":"assistant"}\n', 'utf8');
  assert.equal(await readSessionCwd(filePath), null);
});

test('readFirstUserPrompt: returns the first user prompt from the head', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-fup-'));
  const filePath = path.join(dir, 'sess.jsonl');
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ type: 'system' })}\n${JSON.stringify({ type: 'user', message: { content: 'hello there' } })}\n`,
    'utf8',
  );
  assert.equal(await readFirstUserPrompt(filePath), 'hello there');
});

test('readFirstUserPrompt: returns null when no user entry in the head', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-fup-'));
  const filePath = path.join(dir, 'sess.jsonl');
  await fs.writeFile(filePath, `${JSON.stringify({ type: 'system' })}\n`, 'utf8');
  assert.equal(await readFirstUserPrompt(filePath), null);
});

/**
 * Create an isolated fixture: a real workdir under tmpdir + an injectable
 * projects-root mirroring ~/.claude/projects.
 * @returns {Promise<{workCwd: string, projectsRoot: string, cleanup: () => Promise<void>}>}
 */
const makeFixture = async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-test-'));
  const workCwd = path.join(base, 'work');
  const projectsRoot = path.join(base, 'projects');
  await fs.mkdir(workCwd);
  await fs.mkdir(projectsRoot);
  return {
    workCwd,
    projectsRoot,
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
};

const writeTranscript = async (dir, sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') => {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: '2026-05-01T10:00:00Z' })}\n`,
  );
};

test('findSubProjects: returns real sub-projects with displayLabel=cwd and missing=false', async () => {
  const { workCwd, projectsRoot, cleanup } = await makeFixture();
  try {
    const realSub = path.join(workCwd, 'pkg-a');
    await fs.mkdir(realSub);
    await writeTranscript(path.join(projectsRoot, encodeCwd(realSub)));

    const subs = await findSubProjects(workCwd, { projectsRoot });
    assert.equal(subs.length, 1);
    assert.equal(subs[0].cwd, realSub);
    assert.equal(subs[0].displayLabel, realSub);
    assert.equal(subs[0].missing, false);
    assert.equal(subs[0].sessionCount, 1);
  } finally {
    await cleanup();
  }
});

test('findSubProjects: returns orphan with cwd=null, displayLabel=encoded, missing=true', async () => {
  const { workCwd, projectsRoot, cleanup } = await makeFixture();
  try {
    const ghostCwd = path.join(workCwd, 'deleted-pkg');
    const encoded = encodeCwd(ghostCwd);
    // No FS entry for ghostCwd → matches the orphan code path.
    await writeTranscript(path.join(projectsRoot, encoded));

    const subs = await findSubProjects(workCwd, { projectsRoot });
    assert.equal(subs.length, 1);
    assert.equal(subs[0].cwd, null);
    assert.equal(subs[0].displayLabel, encoded);
    assert.equal(subs[0].missing, true);
    assert.equal(subs[0].sessionCount, 1);
  } finally {
    await cleanup();
  }
});

test('findSubProjects: returns both real and orphan entries together', async () => {
  const { workCwd, projectsRoot, cleanup } = await makeFixture();
  try {
    const real = path.join(workCwd, 'zzz-real');
    await fs.mkdir(real);
    await writeTranscript(path.join(projectsRoot, encodeCwd(real)));

    const ghost = path.join(workCwd, 'aaa-ghost');
    await writeTranscript(path.join(projectsRoot, encodeCwd(ghost)));

    const subs = await findSubProjects(workCwd, { projectsRoot });
    assert.equal(subs.length, 2);
    // Don't rely on sort order: localeCompare can yield different results
    // depending on the system locale. Match by content instead.
    const realEntry = subs.find(s => s.cwd === real);
    const orphanEntry = subs.find(s => s.cwd === null);
    assert.ok(realEntry, 'expected the real sub-project in the result');
    assert.equal(realEntry.missing, false);
    assert.ok(orphanEntry, 'expected the orphan sub-project in the result');
    assert.equal(orphanEntry.missing, true);
    assert.equal(orphanEntry.displayLabel, encodeCwd(ghost));
  } finally {
    await cleanup();
  }
});

test('findSubProjects: skips encoded dirs with no .jsonl files', async () => {
  const { workCwd, projectsRoot, cleanup } = await makeFixture();
  try {
    const encoded = `${encodeCwd(workCwd)}-empty`;
    await fs.mkdir(path.join(projectsRoot, encoded));
    // No transcript inside.

    const subs = await findSubProjects(workCwd, { projectsRoot });
    assert.deepEqual(subs, []);
  } finally {
    await cleanup();
  }
});

test('findSubProjects: returns [] when projectsRoot does not exist', async () => {
  const subs = await findSubProjects('/tmp', {
    projectsRoot: path.join(os.tmpdir(), `clh-missing-${Date.now()}`),
  });
  assert.deepEqual(subs, []);
});

test('findSessionGlobally: finds a session living in another project', async () => {
  const { workCwd, projectsRoot, cleanup } = await makeFixture();
  try {
    const otherCwd = path.join(workCwd, 'other');
    const encoded = encodeCwd(otherCwd);
    const id = 'b6eb23f1-9b8a-41b7-8ddd-8d525042f1b5';
    await writeTranscript(path.join(projectsRoot, encoded), id);

    const matches = await findSessionGlobally('b6eb23f1', { projectsRoot });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].sessionId, id);
    assert.equal(matches[0].encodedDir, encoded);
    assert.equal(matches[0].dir, path.join(projectsRoot, encoded));
  } finally {
    await cleanup();
  }
});

test('findSessionGlobally: returns [] when no project holds the prefix', async () => {
  const { projectsRoot, cleanup } = await makeFixture();
  try {
    await writeTranscript(path.join(projectsRoot, '-some-proj'), 'aaaa1111-2222-3333-4444-555555555555');
    const matches = await findSessionGlobally('zzzz', { projectsRoot });
    assert.deepEqual(matches, []);
  } finally {
    await cleanup();
  }
});

test('findSessionGlobally: surfaces matches from distinct projects for the ambiguity check', async () => {
  const { projectsRoot, cleanup } = await makeFixture();
  try {
    // Same 8-char prefix, two different projects → caller must treat as ambiguous.
    await writeTranscript(path.join(projectsRoot, '-proj-a'), 'deadbeef-1111-1111-1111-111111111111');
    await writeTranscript(path.join(projectsRoot, '-proj-b'), 'deadbeef-2222-2222-2222-222222222222');

    const matches = await findSessionGlobally('deadbeef', { projectsRoot });
    assert.equal(matches.length, 2);
    const dirs = matches.map(m => m.encodedDir).toSorted();
    assert.deepEqual(dirs, ['-proj-a', '-proj-b']);
  } finally {
    await cleanup();
  }
});

test('findSessionGlobally: returns [] when projectsRoot does not exist', async () => {
  const matches = await findSessionGlobally('abcd', {
    projectsRoot: path.join(os.tmpdir(), `clh-missing-${Date.now()}`),
  });
  assert.deepEqual(matches, []);
});

test('findParentProjects: includes existing ancestor with transcripts, missing=false', async () => {
  const { workCwd, projectsRoot, cleanup } = await makeFixture();
  try {
    const child = path.join(workCwd, 'child');
    await fs.mkdir(child);
    await writeTranscript(path.join(projectsRoot, encodeCwd(workCwd)));

    const parents = await findParentProjects(child, { projectsRoot });
    const match = parents.find(p => p.cwd === workCwd);
    assert.ok(match, 'expected workCwd in parents');
    assert.equal(match.missing, false);
    assert.equal(match.displayLabel, workCwd);
    assert.equal(match.sessionCount, 1);
  } finally {
    await cleanup();
  }
});

test('findParentProjects: flags ancestor as missing when its path is gone', async () => {
  const { projectsRoot, cleanup } = await makeFixture();
  try {
    // Build an ancestry that doesn't exist on disk. We place a transcript
    // for the encoded form of /nonexistent-clh/parent — that path is never
    // created. Walking up from /nonexistent-clh/parent/child must surface it
    // with missing=true.
    const ghostParent = '/nonexistent-clh-test/parent';
    const ghostChild = path.join(ghostParent, 'child');
    await writeTranscript(path.join(projectsRoot, encodeCwd(ghostParent)));

    const parents = await findParentProjects(ghostChild, { projectsRoot });
    const match = parents.find(p => p.cwd === ghostParent);
    assert.ok(match, 'expected ghostParent to be surfaced');
    assert.equal(match.missing, true);
    assert.equal(match.displayLabel, ghostParent);
    assert.equal(match.sessionCount, 1);
  } finally {
    await cleanup();
  }
});

const writeLines = async (dir, sessionId, entries) => {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
  );
};

test('listSessions: exposes the latest agent-color from the tail', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-color-'));
  try {
    await writeLines(dir, 'aaaaaaaa-0000-0000-0000-000000000000', [
      { type: 'user', message: { content: 'hi' }, timestamp: '2026-05-01T10:00:00Z' },
      { type: 'agent-color', agentColor: 'red' },
      { type: 'custom-title', customTitle: 'Titre' },
      { type: 'agent-color', agentColor: 'yellow' },
    ]);
    const [session] = await listSessions(dir);
    assert.equal(session.color, 'yellow');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('listSessions: color is null when no agent-color entry exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-color-'));
  try {
    await writeLines(dir, 'bbbbbbbb-0000-0000-0000-000000000000', [
      { type: 'user', message: { content: 'hi' }, timestamp: '2026-05-01T10:00:00Z' },
    ]);
    const [session] = await listSessions(dir);
    assert.equal(session.color, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('listSessions: reflects a color written by setSessionColor', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-color-'));
  try {
    const sessionId = 'cccccccc-0000-0000-0000-000000000000';
    await writeLines(dir, sessionId, [
      { type: 'user', message: { content: 'hi' }, timestamp: '2026-05-01T10:00:00Z' },
      { type: 'agent-color', agentColor: 'blue' },
    ]);
    await setSessionColor({ filePath: path.join(dir, `${sessionId}.jsonl`), sessionId, color: 'orange' });
    const [session] = await listSessions(dir);
    assert.equal(session.color, 'orange');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('listSessions: lastActivity is the last message timestamp, not bumped by title/color writes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-activity-'));
  try {
    const sessionId = 'dddddddd-0000-0000-0000-000000000000';
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    await writeLines(dir, sessionId, [
      { type: 'user', message: { content: 'hi' }, timestamp: '2026-05-01T10:00:00Z' },
      { type: 'system', subtype: 'turn_duration', timestamp: '2026-05-01T10:05:00Z' },
      { type: 'last-prompt', lastPrompt: 'hi' },
    ]);
    await renameSession({ filePath, sessionId, title: 'Titre' });
    await setSessionColor({ filePath, sessionId, color: 'pink' });
    const [session] = await listSessions(dir);
    assert.equal(session.lastActivity.toISOString(), '2026-05-01T10:05:00.000Z');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('listSessions: lastActivity falls back to the file mtime without any timestamp', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-activity-'));
  try {
    const sessionId = 'eeeeeeee-0000-0000-0000-000000000000';
    await writeLines(dir, sessionId, [{ type: 'ai-title', aiTitle: 'Titre' }]);
    const mtime = new Date('2026-03-02T08:00:00Z');
    await fs.utimes(path.join(dir, `${sessionId}.jsonl`), mtime, mtime);
    const [session] = await listSessions(dir);
    assert.equal(session.lastActivity.toISOString(), mtime.toISOString());
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('listSessions: sorts by lastActivity, ignoring a fresher mtime', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-activity-'));
  try {
    const older = 'ffffffff-0000-0000-0000-000000000001';
    const newer = 'ffffffff-0000-0000-0000-000000000002';
    await writeLines(dir, newer, [{ type: 'user', message: { content: 'b' }, timestamp: '2026-05-02T10:00:00Z' }]);
    // Written last, so its mtime is the freshest — yet its last message is older.
    await writeLines(dir, older, [{ type: 'user', message: { content: 'a' }, timestamp: '2026-05-01T10:00:00Z' }]);
    const sessions = await listSessions(dir);
    assert.deepEqual(sessions.map(s => s.sessionId), [newer, older]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('listSessions: finds title and color re-appended well before the last 8 KB', async () => {
  // Claude Code re-appends its metadata block only now and then, sizing it for
  // its own 64 KB tail window; a turn can push it tens of KB from the end.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-tail-'));
  try {
    const sessionId = '99999999-0000-0000-0000-000000000000';
    const filler = Array.from({ length: 20 }, (_, i) => ({
      type: 'assistant',
      message: { content: 'x'.repeat(1000) },
      timestamp: `2026-05-01T10:${String(i).padStart(2, '0')}:00Z`,
    }));
    await writeLines(dir, sessionId, [
      { type: 'user', message: { content: 'hi' }, timestamp: '2026-05-01T09:00:00Z' },
      { type: 'ai-title', aiTitle: 'Titre lointain' },
      { type: 'agent-color', agentColor: 'orange' },
      ...filler,
    ]);
    const [session] = await listSessions(dir);
    assert.equal(session.title, 'Titre lointain');
    assert.equal(session.color, 'orange');
    assert.equal(session.lastActivity.toISOString(), '2026-05-01T10:19:00.000Z');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const usage = (input, creation, read, output) => ({
  input_tokens: input,
  cache_creation_input_tokens: creation,
  cache_read_input_tokens: read,
  output_tokens: output,
});

test('listSessions: contextTokens sums the last assistant usage', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-tokens-'));
  try {
    await writeLines(dir, '11111111-0000-0000-0000-000000000000', [
      { type: 'user', message: { content: 'hi' }, timestamp: '2026-05-01T10:00:00Z' },
      { type: 'assistant', message: { usage: usage(1, 1, 1, 1) }, timestamp: '2026-05-01T10:01:00Z' },
      { type: 'assistant', message: { usage: usage(2, 2041, 338010, 968) }, timestamp: '2026-05-01T10:02:00Z' },
      { type: 'custom-title', customTitle: 'Titre' },
    ]);
    const [session] = await listSessions(dir);
    assert.equal(session.contextTokens, 341021);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('listSessions: contextTokens skips a zero-usage synthetic message', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-tokens-'));
  try {
    await writeLines(dir, '22222222-0000-0000-0000-000000000000', [
      { type: 'assistant', message: { usage: usage(10, 0, 90, 0) }, timestamp: '2026-05-01T10:01:00Z' },
      { type: 'assistant', message: { model: '<synthetic>', usage: usage(0, 0, 0, 0) }, timestamp: '2026-05-01T10:02:00Z' },
    ]);
    const [session] = await listSessions(dir);
    assert.equal(session.contextTokens, 100);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('listSessions: contextTokens is the post-compaction size after a trailing compact', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-tokens-'));
  try {
    await writeLines(dir, '33333333-0000-0000-0000-000000000000', [
      { type: 'assistant', message: { usage: usage(1, 0, 158000, 863) }, timestamp: '2026-05-01T10:01:00Z' },
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 158864, postTokens: 12856 } },
    ]);
    const [session] = await listSessions(dir);
    assert.equal(session.contextTokens, 12856);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('listSessions: contextTokens is null without any usage in the tail', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clh-tokens-'));
  try {
    await writeLines(dir, '44444444-0000-0000-0000-000000000000', [
      { type: 'user', message: { content: 'hi' }, timestamp: '2026-05-01T10:00:00Z' },
    ]);
    const [session] = await listSessions(dir);
    assert.equal(session.contextTokens, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
