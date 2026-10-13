import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOsc11, isDarkRgb, detectTheme } from './terminal-theme.mjs';

test('parseOsc11: reads a 4-digit reply terminated by BEL', () => {
  assert.deepEqual(parseOsc11('\x1b]11;rgb:ffff/8080/0000\x07'), [1, 0x8080 / 0xffff, 0]);
});

test('parseOsc11: reads a 2-digit reply terminated by ST', () => {
  assert.deepEqual(parseOsc11('\x1b]11;rgb:00/ff/00\x1b\\'), [0, 1, 0]);
});

test('parseOsc11: null for anything else', () => {
  assert.equal(parseOsc11(''), null);
  assert.equal(parseOsc11('\x1b[?1;2c'), null);
});

test('isDarkRgb: by relative luminance', () => {
  assert.equal(isDarkRgb([0.1, 0.1, 0.12]), true);
  assert.equal(isDarkRgb([1, 1, 1]), false);
  assert.equal(isDarkRgb([0, 0, 1]), true);
});

const never = async () => null;

test('detectTheme: CLH_THEME wins over the terminal and GNOME', async () => {
  const theme = await detectTheme({ env: { CLH_THEME: 'dark' }, queryBackground: async () => [1, 1, 1], gnomeScheme: never });
  assert.equal(theme, 'dark');
});

test('detectTheme: the terminal background wins over GNOME', async () => {
  const theme = await detectTheme({ env: {}, queryBackground: async () => [0.1, 0.1, 0.1], gnomeScheme: async () => "'prefer-light'" });
  assert.equal(theme, 'dark');
});

test('detectTheme: GNOME prefer-dark when the terminal does not answer', async () => {
  assert.equal(await detectTheme({ env: {}, queryBackground: never, gnomeScheme: async () => "'prefer-dark'" }), 'dark');
});

test('detectTheme: light by default', async () => {
  assert.equal(await detectTheme({ env: { CLH_THEME: 'bogus' }, queryBackground: never, gnomeScheme: never }), 'light');
});
