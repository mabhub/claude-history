import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCwd, resolveId, truncate, formatDate } from './util.mjs';

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

test('formatDate: ISO string', () => {
  // Use a UTC moment but check local format presence — locale-dependent values
  // are unstable, so just assert structure.
  const out = formatDate('2026-05-24T12:34:56.000Z');
  assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('formatDate: invalid input', () => {
  assert.equal(formatDate('not-a-date'), '????-??-?? ??:??');
});
