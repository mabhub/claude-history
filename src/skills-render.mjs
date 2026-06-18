import pc from 'picocolors';

/**
 * Rendering helpers for the `skills` subcommand. Kept separate from the pure
 * aggregations in skills.mjs so the analytics stay format-agnostic and unit
 * testable. Each renderer takes already-aggregated rows and returns a string;
 * the command layer picks the renderer from --format.
 */

/** Quote a CSV field per RFC 4180 only when needed. */
const csvCell = value => {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Render an array of objects as CSV. Column order follows `columns`.
 * @param {string[]} columns
 * @param {Array<Object>} rows
 * @returns {string}
 */
export const toCsv = (columns, rows) => {
  const head = columns.map(csvCell).join(',');
  const body = rows.map(r => columns.map(c => csvCell(r[c])).join(','));
  return [head, ...body].join('\n');
};

/** Pretty-print JSON with a trailing newline-free body. */
export const toJson = value => JSON.stringify(value, null, 2);

/**
 * Render an aligned text table with a header. Numeric columns are right-aligned.
 * @param {Array<{key: string, label: string, align?: 'left'|'right'}>} columns
 * @param {Array<Object>} rows
 * @returns {string}
 */
export const toTable = (columns, rows) => {
  const widths = columns.map(col =>
    Math.max(col.label.length, ...rows.map(r => String(r[col.key] ?? '').length), 0),
  );
  const pad = (text, width, align) =>
    align === 'right' ? String(text).padStart(width) : String(text).padEnd(width);
  const header = columns.map((c, i) => pc.bold(pad(c.label, widths[i], c.align))).join('  ');
  const sep = columns.map((_, i) => '-'.repeat(widths[i])).join('  ');
  const body = rows.map(r => columns.map((c, i) => pad(r[c.key] ?? '', widths[i], c.align)).join('  '));
  return [header, sep, ...body].join('\n');
};

/**
 * A unicode bar of a value scaled to `max` over `width` cells. Any positive
 * value renders at least one cell so the long tail stays visible (a sub-1/(2·width)
 * ratio would otherwise round to an empty bar, indistinguishable from zero).
 */
export const bar = (value, max, width = 24) => {
  if (!max || value <= 0) return '';
  return '█'.repeat(Math.max(1, Math.round((value / max) * width)));
};
