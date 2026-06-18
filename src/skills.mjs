import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { defaultProjectsRoot } from './util.mjs';

/**
 * Skill usage analytics over Claude Code transcripts.
 *
 * Two activation channels are tracked, because Claude Code records them
 * differently and only one of them was historically counted:
 *
 *   - `tool`  : the assistant invoked the `Skill` tool. Logged as a
 *               `tool_use` block (name === 'Skill', input.skill === name),
 *               paired with a `tool_result`. Success looks like
 *               "Launching skill: <name>"; failure carries `is_error: true`
 *               and "<tool_use_error>Unknown skill: <name></tool_use_error>".
 *   - `slash` : the user typed `/<skill>`. Claude Code expands the slash
 *               command inline into a user message starting with
 *               "Base directory for this skill: <…>/skills/<name>" — no
 *               `Skill` tool_use is emitted at all. These are real
 *               activations that the tool-only view misses entirely.
 *
 * Every invocation becomes one normalized event (see {@link extractEvents}).
 * All aggregations are pure functions over that event array, so the disk is
 * walked exactly once and any new view is free.
 */

const SLASH_MARKER = 'Base directory for this skill:';
const SLASH_RE = /Base directory for this skill:\s*\S*?\/skills\/([\w:-]+)/;
const UNKNOWN_RE = /Unknown skill:\s*([\w:-]+)/;

/**
 * Split a raw skill name into a canonical key and its namespace. The tool
 * channel logs plugin skills with their namespace (`superpowers:brainstorming`)
 * while the slash channel logs the bare directory name (`brainstorming`).
 * Grouping on the canonical key reconciles the two so the same skill isn't
 * split in two. Skills with no `plugin:` prefix get the `builtin` namespace.
 * @param {string} raw - Skill name as recorded
 * @returns {{skill: string, namespace: string}}
 */
export const canonicalize = raw => {
  const idx = raw.indexOf(':');
  if (idx === -1) return { skill: raw, namespace: 'builtin' };
  return { skill: raw.slice(idx + 1), namespace: raw.slice(0, idx) };
};

/**
 * @typedef {Object} SkillEvent
 * @property {string} skill        - Canonical skill key (namespace prefix stripped), used for all grouping
 * @property {string} skillRaw     - Skill name exactly as recorded (keeps the namespace, may be invalid for failed calls)
 * @property {string} namespace    - Plugin namespace ('superpowers', …) or 'builtin' when unprefixed
 * @property {string|null} ts      - ISO timestamp of the invocation, or null if absent
 * @property {string|null} session - sessionId owning the invocation
 * @property {string} project      - Encoded project dir name (e.g. "-home-bma-projets-foo")
 * @property {'tool'|'slash'} channel - How the skill was activated
 * @property {'main'|'subagent'} agent - Whether the invocation came from the main loop or a dispatched subagent
 * @property {string|null} caller  - caller.type for tool invocations ('direct', etc.), null for slash
 * @property {'success'|'error'|'unknown'} status - Resolved outcome
 * @property {string|null} errorKind - Coarse failure reason (e.g. 'unknown-skill'), null on success
 */

/** @returns {string} The transcripts root, honoring CLAUDE_PROJECTS_ROOT-style overrides via discover defaults. */
export const projectsRoot = () => defaultProjectsRoot();

/**
 * Stream-parse a single .jsonl transcript into normalized skill events.
 * Reads line by line to stay flat in memory on large transcripts, but keeps a
 * per-file index of Skill tool_use ids so each can be paired with its result.
 * @param {string} filePath - Absolute path to a .jsonl transcript
 * @param {string} project - Encoded project directory name (for the `project` field)
 * @param {'main'|'subagent'} [agent='main'] - Agent level owning the transcript
 * @returns {Promise<SkillEvent[]>}
 */
export const extractEventsFromFile = async (filePath, project, agent = 'main') => {
  /** @type {Map<string, {skill: string, ts: string|null, session: string|null, caller: string|null}>} */
  const pendingTool = new Map();
  /** @type {Map<string, {is_error: boolean, text: string}>} */
  const results = new Map();
  /** @type {SkillEvent[]} */
  const slashEvents = [];

  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Cheap pre-filter: skip lines that can't carry a skill signal.
    const maybeTool = trimmed.includes('"name":"Skill"') || trimmed.includes('"tool_result"');
    const maybeSlash = trimmed.includes(SLASH_MARKER);
    if (!maybeTool && !maybeSlash) continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const message = event?.message;
    const content = Array.isArray(message?.content) ? message.content : null;
    if (!content) continue;

    const ts = event?.timestamp ?? null;
    const session = event?.sessionId ?? null;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'tool_use' && block.name === 'Skill') {
        const skill = block?.input?.skill;
        if (typeof skill === 'string' && block.id) {
          pendingTool.set(block.id, { skill, ts, session, caller: block?.caller?.type ?? null });
        }
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        const raw = block.content;
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
        results.set(block.tool_use_id, { is_error: block.is_error === true, text });
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.includes(SLASH_MARKER)) {
        const match = block.text.match(SLASH_RE);
        if (match) {
          const { skill, namespace } = canonicalize(match[1]);
          slashEvents.push({
            skill,
            skillRaw: match[1],
            namespace,
            ts,
            session,
            project,
            channel: 'slash',
            agent,
            caller: null,
            status: 'success',
            errorKind: null,
          });
        }
      }
    }
  }

  /** @type {SkillEvent[]} */
  const toolEvents = [];
  for (const [id, info] of pendingTool) {
    const result = results.get(id);
    let status = 'unknown';
    let errorKind = null;
    if (result) {
      if (result.is_error) {
        status = 'error';
        errorKind = UNKNOWN_RE.test(result.text) ? 'unknown-skill' : 'other';
      } else {
        status = 'success';
      }
    }
    const { skill, namespace } = canonicalize(info.skill);
    toolEvents.push({
      skill,
      skillRaw: info.skill,
      namespace,
      ts: info.ts,
      session: info.session,
      project,
      channel: 'tool',
      agent,
      caller: info.caller,
      status,
      errorKind,
    });
  }

  return [...toolEvents, ...slashEvents];
};

/**
 * Walk every project directory under the transcripts root and extract all
 * skill events. Directories and unreadable files are skipped silently so one
 * corrupt transcript can't abort the whole run.
 * @param {Object} [options]
 * @param {string} [options.root] - Override the transcripts root
 * @param {(name: string) => boolean} [options.projectFilter] - Keep only matching encoded project names
 * @param {boolean} [options.dedupe=true] - Collapse tool+slash double-logging of one activation
 * @returns {Promise<SkillEvent[]>}
 */
export const extractEvents = async ({ root = projectsRoot(), projectFilter, dedupe: doDedupe = true } = {}) => {
  let projects;
  try {
    projects = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const events = [];
  for (const entry of projects) {
    if (!entry.isDirectory()) continue;
    if (projectFilter && !projectFilter(entry.name)) continue;
    // Each project dir holds top-level session transcripts plus nested
    // `<sessionId>/subagents/*.jsonl` for dispatched subagents. Walking the
    // whole subtree captures both; the subagents marker sets the agent level.
    await walkProject(path.join(root, entry.name), entry.name, events);
  }
  return doDedupe ? dedupe(events) : events;
};

/**
 * Recursively collect skill events from every .jsonl under a project subtree.
 * Files anywhere below a `subagents/` segment are tagged as subagent-level.
 * @param {string} dir - Absolute directory to walk
 * @param {string} project - Encoded project directory name
 * @param {SkillEvent[]} sink - Accumulator the events are pushed into
 * @returns {Promise<void>}
 */
const walkProject = async (dir, project, sink) => {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkProject(full, project, sink);
    } else if (entry.name.endsWith('.jsonl')) {
      const agent = full.includes(`${path.sep}subagents${path.sep}`) ? 'subagent' : 'main';
      try {
        const fileEvents = await extractEventsFromFile(full, project, agent);
        sink.push(...fileEvents);
      } catch {
        // Skip a single unreadable/corrupt transcript without failing the run.
      }
    }
  }
};

const DEDUPE_WINDOW_MS = 5000;

/**
 * Collapse the duplicate logging of a single activation. When a skill is run
 * via the Skill tool, Claude Code emits BOTH a `tool_use` block AND an inline
 * slash-expansion user message ("Base directory for this skill: …") a moment
 * apart — counting both double-counts the invocation. We drop the slash event
 * when a matching tool event (same canonical skill, session and agent, within
 * a few seconds) exists. Slash events with no tool twin are genuine
 * user-typed `/skill` activations and are kept. The surviving tool event is
 * tagged `bothChannels: true` so the dual logging stays visible.
 *
 * Events without a timestamp can't be windowed, so they're matched on
 * (skill, session, agent) regardless of time — conservative for our data
 * where missing timestamps are rare.
 * @param {SkillEvent[]} events
 * @returns {SkillEvent[]}
 */
export const dedupe = events => {
  const toolByKey = new Map();
  for (const e of events) {
    if (e.channel !== 'tool') continue;
    const key = compositeKey(e.skill, e.session ?? '', e.agent);
    let list = toolByKey.get(key);
    if (!list) {
      list = [];
      toolByKey.set(key, list);
    }
    list.push(e);
  }
  // Track twinned tool events and lone slash survivors without mutating the
  // input array: `matched` holds tool events that absorbed a slash twin (each
  // can absorb at most one), `survivors` holds slash events with no twin.
  const matched = new Set();
  const survivors = [];
  for (const e of events) {
    if (e.channel === 'tool') continue;
    const key = compositeKey(e.skill, e.session ?? '', e.agent);
    const candidates = toolByKey.get(key);
    const twin = candidates?.find(t => {
      if (matched.has(t)) return false;
      if (!t.ts || !e.ts) return true;
      return Math.abs(new Date(t.ts) - new Date(e.ts)) <= DEDUPE_WINDOW_MS;
    });
    if (twin) matched.add(twin);
    else survivors.push(e);
  }
  // Emit tool events first (cloning the twinned ones so the `bothChannels` tag
  // never leaks back onto the caller's objects), then the lone slash events.
  const tools = events
    .filter(e => e.channel === 'tool')
    .map(e => (matched.has(e) ? { ...e, bothChannels: true } : e));
  return [...tools, ...survivors];
};

// ---------------------------------------------------------------------------
// Pure aggregations over the event array
// ---------------------------------------------------------------------------

// NUL can't appear in a skill name, an encoded project dir ([^a-z0-9]→-) or a
// period bucket, so it's a safe join separator for composite Map keys — unlike
// a space, which a future non-canonical value could carry and split wrong.
const KEY_SEP = ' ';

/** Join parts into a composite Map key with a separator that can't occur in the data. */
const compositeKey = (...parts) => parts.join(KEY_SEP);

/** Inverse of {@link compositeKey}. */
const splitKey = key => key.split(KEY_SEP);

/**
 * Apply CLI-level filters to an event array. All filters are optional and
 * combine with AND semantics.
 * @param {SkillEvent[]} events
 * @param {Object} [filters]
 * @param {RegExp} [filters.skill] - Keep events whose skill name matches
 * @param {'tool'|'slash'|'all'} [filters.channel] - Keep one channel
 * @param {string} [filters.since] - ISO lower bound (inclusive) on ts
 * @param {string} [filters.until] - ISO upper bound (inclusive) on ts
 * @returns {SkillEvent[]}
 */
export const filterEvents = (events, { skill, channel = 'all', since, until } = {}) =>
  events.filter(e => {
    if (skill && !skill.test(e.skill)) return false;
    if (channel !== 'all' && e.channel !== channel) return false;
    if (since && (!e.ts || e.ts < since)) return false;
    if (until && (!e.ts || e.ts > until)) return false;
    return true;
  });

/** @returns {string} Period key for an ISO timestamp at the given bucket granularity. */
export const bucketOf = (ts, bucket) => {
  if (!ts) return 'unknown';
  if (bucket === 'day') return ts.slice(0, 10);
  if (bucket === 'month') return ts.slice(0, 7);
  if (bucket === 'week') {
    // ISO week (UTC), formatted as YYYY-Www. Cheap and stable for bucketing.
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return 'unknown';
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNr = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNr + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  return ts.slice(0, 7); // default: month granularity for any unrecognized bucket
};

/**
 * Per-skill summary: invocation count, distinct sessions, distinct projects,
 * and a success/error/unknown breakdown. Sorted by total count desc.
 * @param {SkillEvent[]} events
 * @returns {Array<{skill: string, count: number, sessions: number, projects: number, success: number, error: number, unknown: number, slash: number, tool: number}>}
 */
export const summarize = events => {
  const map = new Map();
  for (const e of events) {
    let s = map.get(e.skill);
    if (!s) {
      s = { skill: e.skill, namespace: e.namespace, count: 0, sessions: new Set(), projects: new Set(), success: 0, error: 0, unknown: 0, slash: 0, tool: 0, subagent: 0 };
      map.set(e.skill, s);
    }
    s.count += 1;
    if (e.session) s.sessions.add(e.session);
    s.projects.add(e.project);
    s[e.status] += 1;
    s[e.channel] += 1;
    if (e.agent === 'subagent') s.subagent += 1;
  }
  return [...map.values()]
    .map(s => ({ ...s, sessions: s.sessions.size, projects: s.projects.size }))
    .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));
};

/**
 * Time series as long-format rows (period, skill, count). The most reusable
 * shape for re-injection into a spreadsheet or plotting tool.
 * @param {SkillEvent[]} events
 * @param {'day'|'week'|'month'} bucket
 * @returns {Array<{period: string, skill: string, count: number}>}
 */
export const timeseriesLong = (events, bucket) => {
  const map = new Map();
  for (const e of events) {
    const key = compositeKey(bucketOf(e.ts, bucket), e.skill);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([key, count]) => {
      const [period, skill] = splitKey(key);
      return { period, skill, count };
    })
    .sort((a, b) => a.period.localeCompare(b.period) || a.skill.localeCompare(b.skill));
};

/**
 * Pivot the long series into a dense matrix: one row per period, one column
 * per skill, zero-filled. Columns are ordered by overall frequency desc.
 * @param {SkillEvent[]} events
 * @param {'day'|'week'|'month'} bucket
 * @returns {{periods: string[], skills: string[], rows: Array<{period: string, counts: number[]}>}}
 */
export const timeseriesPivot = (events, bucket) => {
  const long = timeseriesLong(events, bucket);
  const totals = new Map();
  const periodSet = new Set();
  for (const { period, skill, count } of long) {
    periodSet.add(period);
    totals.set(skill, (totals.get(skill) ?? 0) + count);
  }
  const skills = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
  const skillIndex = new Map(skills.map((s, i) => [s, i]));
  const periods = [...periodSet].sort();
  const periodIndex = new Map(periods.map((p, i) => [p, i]));
  const rows = periods.map(period => ({ period, counts: new Array(skills.length).fill(0) }));
  for (const { period, skill, count } of long) {
    rows[periodIndex.get(period)].counts[skillIndex.get(skill)] = count;
  }
  return { periods, skills, rows };
};

/**
 * Success/error breakdown per skill, plus the list of skill names that failed
 * with an "Unknown skill" result (real typos/invalid invocations).
 * @param {SkillEvent[]} events
 * @returns {{rows: Array<{skill: string, total: number, success: number, error: number, unknown: number, rate: number}>, unknownSkills: Array<{skill: string, count: number}>}}
 */
export const successBreakdown = events => {
  const map = new Map();
  const unknown = new Map();
  for (const e of events) {
    let s = map.get(e.skill);
    if (!s) {
      s = { skill: e.skill, total: 0, success: 0, error: 0, unknown: 0 };
      map.set(e.skill, s);
    }
    s.total += 1;
    s[e.status] += 1;
    if (e.errorKind === 'unknown-skill') unknown.set(e.skill, (unknown.get(e.skill) ?? 0) + 1);
  }
  const rows = [...map.values()]
    .map(s => ({ ...s, rate: s.total ? s.success / s.total : 0 }))
    .sort((a, b) => b.total - a.total || a.skill.localeCompare(b.skill));
  const unknownSkills = [...unknown.entries()]
    .map(([skill, count]) => ({ skill, count }))
    .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));
  return { rows, unknownSkills };
};

/**
 * Unordered skill pairs co-occurring within the same session, with the number
 * of sessions in which each pair appears. Reveals real workflows
 * (e.g. brainstorming → writing-plans → executing-plans).
 * @param {SkillEvent[]} events
 * @returns {Array<{a: string, b: string, sessions: number}>}
 */
export const cooccurrence = events => {
  const bySession = new Map();
  for (const e of events) {
    if (!e.session) continue;
    let set = bySession.get(e.session);
    if (!set) {
      set = new Set();
      bySession.set(e.session, set);
    }
    set.add(e.skill);
  }
  const pairCount = new Map();
  for (const set of bySession.values()) {
    const skills = [...set].sort();
    for (let i = 0; i < skills.length; i += 1) {
      for (let j = i + 1; j < skills.length; j += 1) {
        const key = compositeKey(skills[i], skills[j]);
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }
  return [...pairCount.entries()]
    .map(([key, sessions]) => {
      const [a, b] = splitKey(key);
      return { a, b, sessions };
    })
    .sort((x, y) => y.sessions - x.sessions || x.a.localeCompare(y.a));
};

/**
 * Skill × project matrix as long rows.
 * @param {SkillEvent[]} events
 * @returns {Array<{project: string, skill: string, count: number}>}
 */
export const byProject = events => {
  const map = new Map();
  for (const e of events) {
    const key = compositeKey(e.project, e.skill);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([key, count]) => {
      const [project, skill] = splitKey(key);
      return { project, skill, count };
    })
    .sort((a, b) => b.count - a.count || a.project.localeCompare(b.project));
};
