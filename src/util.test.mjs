import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCwd, resolveId, truncate, formatDate, formatTokens, formatAge, formatSessionRow, tintTitle, tintTokens, cycleColor } from './util.mjs';

test('encodeCwd: replaces slashes', () => {
  assert.equal(encodeCwd('/home/you/claude'), '-home-you-claude');
});

test('encodeCwd: replaces dots (Claude treats them like other separators)', () => {
  assert.equal(encodeCwd('/home/you/.claude'), '-home-you--claude');
  assert.equal(
    encodeCwd('/home/you/.oh-my-zsh/custom/plugins/foobar'),
    '-home-you--oh-my-zsh-custom-plugins-foobar',
  );
});

test('encodeCwd: replaces accented characters', () => {
  assert.equal(encodeCwd('/home/you/Santé/2026'), '-home-you-Sant--2026');
});

test('encodeCwd: preserves alphanumerics and digits', () => {
  assert.equal(encodeCwd('/usr/local/bin/v2'), '-usr-local-bin-v2');
});

test('resolveId: exact full match', () => {
  const ids = ['abc12345-aaaa-bbbb-cccc-dddddddddddd'];
  assert.equal(resolveId('abc12345-aaaa-bbbb-cccc-dddddddddddd', ids), ids[0]);
});

test('resolveId: short prefix match', () => {
  const ids = ['abc12345-...', 'xyz98765-...'];
  assert.equal(resolveId('abc1', ids), 'abc12345-...');
});

test('resolveId: throws when too short', () => {
  assert.throws(() => resolveId('ab', ['abc12345']), /too short/);
});

test('resolveId: throws when no match', () => {
  assert.throws(() => resolveId('zzzz', ['abc12345']), /No conversation matches/);
});

test('resolveId: throws when ambiguous', () => {
  const ids = ['abcd1234', 'abcd5678'];
  assert.throws(() => resolveId('abcd', ids), /Ambiguous/);
});

test('truncate: short input returned unchanged', () => {
  assert.equal(truncate('hello', 10), 'hello');
});

test('truncate: long input cut with ellipsis', () => {
  assert.equal(truncate('hello world', 8), 'hello w…');
});

test('truncate: collapses whitespace', () => {
  assert.equal(truncate('hello   \n\t world', 20), 'hello world');
});

test('truncate: empty string', () => {
  assert.equal(truncate('', 10), '');
});

test('formatAge: picks the right unit for each elapsed range', () => {
  const now = Date.UTC(2026, 6, 22, 12, 0, 0);
  const ago = seconds => new Date(now - seconds * 1000);
  assert.equal(formatAge(ago(2), now), 'à l\'instant');
  assert.equal(formatAge(ago(42), now), 'il y a 42s');
  assert.equal(formatAge(ago(5 * 60), now), 'il y a 5min');
  assert.equal(formatAge(ago(3 * 3600), now), 'il y a 3h');
  assert.equal(formatAge(ago(2 * 86400), now), 'il y a 2j');
  assert.equal(formatAge(ago(10 * 86400), now), 'il y a 1sem');
  assert.equal(formatAge(ago(60 * 86400), now), 'il y a 2mois');
  assert.equal(formatAge(ago(400 * 86400), now), 'il y a 1an');
  assert.equal(formatAge(ago(800 * 86400), now), 'il y a 2ans');
});

test('formatAge: future or invalid dates return a placeholder', () => {
  const now = Date.UTC(2026, 6, 22, 12, 0, 0);
  assert.equal(formatAge(new Date(now + 5000), now), '?');
  assert.equal(formatAge('not-a-date', now), '?');
});

test('formatTokens: units, rounding and placeholder', () => {
  assert.equal(formatTokens(812), '812 tok');
  assert.equal(formatTokens(4249), '4.2K tok');
  assert.equal(formatTokens(48_400), '48K tok');
  assert.equal(formatTokens(341_021), '341K tok');
  assert.equal(formatTokens(999_600), '1M tok');
  assert.equal(formatTokens(1_234_567), '1.2M tok');
  assert.equal(formatTokens(null), '?');
});

test('tintTokens: picks the claude-statusline context color for each threshold', () => {
  const rgbOf = tokens => tintTokens('x', tokens, true).match(/38;2;([\d;]+)m/)?.[1];
  assert.equal(rgbOf(0), '30;142;62');
  assert.equal(rgbOf(60_999), '30;142;62');
  assert.equal(rgbOf(61_000), '76;175;80');
  assert.equal(rgbOf(175_000), '255;160;0');
  assert.equal(rgbOf(200_999), '255;109;0');
  assert.equal(rgbOf(341_021), '194;24;91');
  assert.equal(rgbOf(401_000), '123;31;162');
});

test('tintTokens: no palette color for an unknown count, plain text when disabled', () => {
  assert.doesNotMatch(tintTokens('?', null, true), /38;2;/);
  assert.equal(tintTokens('48K tok', 48_000, false), '48K tok');
});

test('formatSessionRow: includes id, date, age, tokens and title in order', () => {
  const now = Date.UTC(2026, 6, 22, 12, 0, 0);
  const row = formatSessionRow(
    { sessionId: 'a1b2c3d4-eeee-ffff', lastActivity: new Date(now - 2 * 3600 * 1000), contextTokens: 3481, title: 'Mon titre' },
    now,
  );
  // Assert on substrings so the check is agnostic to ANSI color codes.
  assert.match(row, /a1b2c3d4/);
  assert.match(row, /2026-07-22/);
  assert.match(row, /il y a 2h/);
  assert.match(row, /3\.5K tok/);
  assert.match(row, /Mon titre/);
  // Ordering: id before date before age before tokens before title.
  const order = ['a1b2c3d4', '2026-07-22', 'il y a 2h', '3.5K tok', 'Mon titre']
    .map(part => row.indexOf(part));
  assert.deepEqual(order, [...order].toSorted((a, b) => a - b));
});

test('formatDate: ISO string', () => {
  // Use a UTC moment but check local format presence — locale-dependent values
  // are unstable, so just assert structure.
  const out = formatDate('2026-05-24T12:34:56.000Z');
  assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('formatDate: invalid input', () => {
  assert.equal(formatDate('not-a-date'), '????-??-?? ??:??');
});

test('tintTitle: renders a known /color with Claude Code\'s RGB value', () => {
  assert.equal(tintTitle('Titre', 'pink', true), '\x1b[38;2;196;102;134mTitre\x1b[39m');
  assert.equal(tintTitle('Titre', 'blue', true), '\x1b[38;2;106;155;204mTitre\x1b[39m');
});

test('tintTitle: leaves the title untouched without a known color', () => {
  assert.equal(tintTitle('Titre', null, true), 'Titre');
  assert.equal(tintTitle('Titre', 'default', true), 'Titre');
  assert.equal(tintTitle('Titre', 'turquoise', true), 'Titre');
});

test('tintTitle: leaves the title untouched when colors are disabled', () => {
  assert.equal(tintTitle('Titre', 'pink', false), 'Titre');
});

test('cycleColor: steps forward and backward through the palette', () => {
  assert.equal(cycleColor('red', 1), 'blue');
  assert.equal(cycleColor('blue', -1), 'red');
});

test('cycleColor: "default" sits between cyan and red, closing the loop', () => {
  assert.equal(cycleColor('cyan', 1), 'default');
  assert.equal(cycleColor('default', 1), 'red');
  assert.equal(cycleColor('red', -1), 'default');
  assert.equal(cycleColor('default', -1), 'cyan');
});

test('cycleColor: a missing or unknown color starts from "default"', () => {
  assert.equal(cycleColor(null, 1), 'red');
  assert.equal(cycleColor(undefined, -1), 'cyan');
  assert.equal(cycleColor('turquoise', 1), 'red');
});
