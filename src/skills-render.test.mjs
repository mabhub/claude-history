import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, bar } from './skills-render.mjs';

// --- toCsv: RFC 4180 quoting ------------------------------------------------

test('toCsv: leaves plain fields unquoted', () => {
  const out = toCsv(['skill', 'count'], [{ skill: 'brainstorming', count: 3 }]);
  assert.equal(out, 'skill,count\nbrainstorming,3');
});

test('toCsv: quotes fields containing comma, quote or newline', () => {
  const out = toCsv(['a', 'b', 'c'], [{ a: 'x,y', b: 'he said "hi"', c: 'line1\nline2' }]);
  assert.equal(out, 'a,b,c\n"x,y","he said ""hi""","line1\nline2"');
});

test('toCsv: null and undefined render as empty cells', () => {
  const out = toCsv(['a', 'b'], [{ a: null, b: undefined }]);
  assert.equal(out, 'a,b\n,');
});

// --- bar: every positive value stays visible --------------------------------

test('bar: a positive value below the rounding floor still renders one cell', () => {
  // ratio 1/100 over width 24 rounds to 0 cells without the Math.max(1, …) floor
  assert.equal(bar(1, 100, 24), '█');
});

test('bar: zero value and zero max render nothing', () => {
  assert.equal(bar(0, 100), '');
  assert.equal(bar(5, 0), '');
});

test('bar: the max value fills the full width', () => {
  assert.equal(bar(10, 10, 6), '██████');
});
