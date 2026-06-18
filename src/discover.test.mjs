import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathExists, findSubProjects, findParentProjects } from './discover.mjs';
import { encodeCwd } from './util.mjs';

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
