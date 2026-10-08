import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Separator } from '@inquirer/core';
import { nextActiveIndex, initialActiveIndex } from './list-prompt.mjs';

const choice = name => ({ name, value: name });
const sep = () => new Separator();

test('nextActiveIndex: moves one choice down and up', () => {
  const items = [choice('a'), choice('b'), choice('c')];
  assert.equal(nextActiveIndex(items, 0, 1), 1);
  assert.equal(nextActiveIndex(items, 2, -1), 1);
});

test('nextActiveIndex: wraps around both ends', () => {
  const items = [choice('a'), choice('b'), choice('c')];
  assert.equal(nextActiveIndex(items, 2, 1), 0);
  assert.equal(nextActiveIndex(items, 0, -1), 2);
});

test('nextActiveIndex: skips separators, consecutive ones included', () => {
  const items = [choice('a'), sep(), sep(), choice('b')];
  assert.equal(nextActiveIndex(items, 0, 1), 3);
  assert.equal(nextActiveIndex(items, 3, -1), 0);
});

test('nextActiveIndex: skips separators at the ends when wrapping', () => {
  // Same shape as the TUI list: headed by a separator, a blank one before "Quitter".
  const items = [sep(), choice('a'), choice('b'), sep(), choice('quit'), sep()];
  assert.equal(nextActiveIndex(items, 4, 1), 1);
  assert.equal(nextActiveIndex(items, 1, -1), 4);
});

test('nextActiveIndex: stays put on a single choice', () => {
  const items = [sep(), choice('only'), sep()];
  assert.equal(nextActiveIndex(items, 1, 1), 1);
  assert.equal(nextActiveIndex(items, 1, -1), 1);
});

test('initialActiveIndex: lands on the choice holding the value', () => {
  const items = [sep(), choice('a'), choice('b')];
  assert.equal(initialActiveIndex(items, 'b'), 2);
});

test('initialActiveIndex: falls back to the first choice when the value is gone', () => {
  // e.g. the remembered session was just deleted
  const items = [sep(), choice('a'), choice('b')];
  assert.equal(initialActiveIndex(items, 'zzz'), 1);
  assert.equal(initialActiveIndex(items, undefined), 1);
});
