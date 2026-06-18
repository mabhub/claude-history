import fs from 'node:fs/promises';
import pc from 'picocolors';
import {
  extractEvents,
  filterEvents,
  summarize,
  timeseriesLong,
  timeseriesPivot,
  successBreakdown,
  cooccurrence,
  byProject,
  projectsRoot,
} from './skills.mjs';
import { toCsv, toJson, toTable, bar } from './skills-render.mjs';

/**
 * Build a case-insensitive RegExp from a user-supplied `--skill` pattern.
 * A bare word is treated as a substring match; anything with regex
 * metacharacters is used as-is. Returns undefined when no pattern is given.
 * @param {string|undefined} pattern
 * @returns {RegExp|undefined}
 */
const skillMatcher = pattern => {
  if (!pattern) return undefined;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
};

/** Emit a rendered string to --out or stdout. */
const emit = async (text, out) => {
  if (out) {
    await fs.writeFile(out, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    console.error(pc.dim(`→ écrit dans ${out}`));
  } else {
    console.log(text);
  }
};

/** summary view: per-skill counts with success/channel breakdown. */
const viewSummary = (events, format) => {
  const rows = summarize(events);
  if (format === 'json') return toJson(rows);
  if (format === 'csv') return toCsv(['skill', 'namespace', 'count', 'sessions', 'projects', 'success', 'error', 'unknown', 'tool', 'slash', 'subagent'], rows);
  const max = rows[0]?.count ?? 0;
  const table = toTable(
    [
      { key: 'count', label: '#inv', align: 'right' },
      { key: 'sessions', label: '#sess', align: 'right' },
      { key: 'projects', label: '#proj', align: 'right' },
      { key: 'tool', label: 'tool', align: 'right' },
      { key: 'slash', label: 'slash', align: 'right' },
      { key: 'subagent', label: 'sub', align: 'right' },
      { key: 'error', label: 'err', align: 'right' },
      { key: 'skill', label: 'skill' },
      { key: 'graph', label: '' }, // presentational-only column, injected just below for the table format
    ],
    rows.map(r => ({ ...r, graph: pc.cyan(bar(r.count, max)) })),
  );
  const totals = events.length;
  const distinct = rows.length;
  const sessions = new Set(events.map(e => e.session).filter(Boolean)).size;
  const failed = events.filter(e => e.status === 'error').length;
  const tool = events.filter(e => e.channel === 'tool').length;
  const slash = events.filter(e => e.channel === 'slash').length;
  const head = pc.bold(
    `${totals} invocations · ${distinct} skills distinctes · ${sessions} sessions · ${failed} échecs · canal tool=${tool} slash=${slash}`,
  );
  return `${head}\n\n${table}`;
};

/** timeseries view: skill evolution over time, long or pivot. */
const viewTimeseries = (events, format, bucket, pivot) => {
  if (pivot) {
    const { skills, rows } = timeseriesPivot(events, bucket);
    if (format === 'json') return toJson({ bucket, skills, rows });
    if (format === 'csv') {
      const columns = ['period', ...skills];
      const flat = rows.map(r => {
        const obj = { period: r.period };
        skills.forEach((s, i) => { obj[s] = r.counts[i]; });
        return obj;
      });
      return toCsv(columns, flat);
    }
    const columns = [{ key: 'period', label: 'période' }, ...skills.map(s => ({ key: s, label: s, align: 'right' }))];
    const flat = rows.map(r => {
      const obj = { period: r.period };
      skills.forEach((s, i) => { obj[s] = r.counts[i] || ''; });
      return obj;
    });
    return toTable(columns, flat);
  }
  const rows = timeseriesLong(events, bucket);
  if (format === 'json') return toJson(rows);
  if (format === 'csv') return toCsv(['period', 'skill', 'count'], rows);
  return toTable(
    [
      { key: 'period', label: 'période' },
      { key: 'count', label: '#', align: 'right' },
      { key: 'skill', label: 'skill' },
    ],
    rows,
  );
};

/** success view: per-skill success rate + list of Unknown-skill failures. */
const viewSuccess = (events, format) => {
  const { rows, unknownSkills } = successBreakdown(events);
  const withRate = rows.map(r => ({ ...r, rate: `${(r.rate * 100).toFixed(0)}%` }));
  if (format === 'json') return toJson({ rows, unknownSkills });
  if (format === 'csv') return toCsv(['skill', 'total', 'success', 'error', 'unknown', 'rate'], withRate);
  const table = toTable(
    [
      { key: 'total', label: '#', align: 'right' },
      { key: 'success', label: 'ok', align: 'right' },
      { key: 'error', label: 'err', align: 'right' },
      { key: 'rate', label: 'taux', align: 'right' },
      { key: 'skill', label: 'skill' },
    ],
    withRate,
  );
  if (unknownSkills.length === 0) return table;
  const failures = unknownSkills.map(u => `  ${pc.red(u.skill)} ×${u.count}`).join('\n');
  return `${table}\n\n${pc.bold('Noms invalides (Unknown skill) :')}\n${failures}`;
};

/** cooccurrence view: skill pairs sharing a session. */
const viewCooccurrence = (events, format) => {
  const rows = cooccurrence(events);
  if (format === 'json') return toJson(rows);
  if (format === 'csv') return toCsv(['a', 'b', 'sessions'], rows);
  return toTable(
    [
      { key: 'sessions', label: '#sess', align: 'right' },
      { key: 'a', label: 'skill A' },
      { key: 'b', label: 'skill B' },
    ],
    rows,
  );
};

/** by-project view: skill × project matrix (long). */
const viewByProject = (events, format) => {
  const rows = byProject(events);
  if (format === 'json') return toJson(rows);
  if (format === 'csv') return toCsv(['project', 'skill', 'count'], rows);
  return toTable(
    [
      { key: 'count', label: '#', align: 'right' },
      { key: 'skill', label: 'skill' },
      { key: 'project', label: 'project' },
    ],
    rows,
  );
};

/** events view: dump the raw normalized dataset (maximum granularity). */
const viewEvents = (events, format) => {
  if (format === 'json') return toJson(events);
  return toCsv(
    ['ts', 'skill', 'skillRaw', 'namespace', 'channel', 'agent', 'status', 'errorKind', 'caller', 'session', 'project'],
    events,
  );
};

/**
 * Entry point for `claude-history skills`. Walks transcripts once, applies
 * filters, then renders the requested view in the requested format.
 * @param {Object} opts - Parsed commander options
 */
export const cmdSkills = async opts => {
  const root = opts.root || projectsRoot();
  const all = await extractEvents({ root, dedupe: opts.dedupe !== false });
  const events = filterEvents(all, {
    skill: skillMatcher(opts.skill),
    channel: opts.channel ?? 'all',
    since: opts.since,
    until: opts.until,
  });

  if (events.length === 0) {
    console.error(pc.yellow('Aucune invocation de skill ne correspond aux filtres.'));
    return;
  }

  const format = opts.format ?? 'table';
  const bucket = opts.bucket ?? 'month';
  let rendered;

  if (opts.timeseries) rendered = viewTimeseries(events, format, bucket, Boolean(opts.pivot));
  else if (opts.success) rendered = viewSuccess(events, format);
  else if (opts.cooccurrence) rendered = viewCooccurrence(events, format);
  else if (opts.byProject) rendered = viewByProject(events, format);
  else if (opts.events) rendered = viewEvents(events, format);
  else rendered = viewSummary(events, format);

  await emit(rendered, opts.out);
};
