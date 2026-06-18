import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanUserText } from './transcript.mjs';

// picocolors emits ANSI escape codes — strip them for stable assertions.
const stripAnsi = s => s.replaceAll(/\x1B\[[0-9;]*m/g, '');

test('cleanUserText: drops local-command-caveat blocks entirely', () => {
  const input = '<local-command-caveat>noise</local-command-caveat>actual text';
  assert.equal(stripAnsi(cleanUserText(input)), 'actual text');
});

test('cleanUserText: collapses command-name block to [/name]', () => {
  const input = '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>';
  assert.equal(stripAnsi(cleanUserText(input)), '[/clear]');
});

test('cleanUserText: keeps command args', () => {
  const input = '<command-name>/rename</command-name><command-message>rename</command-message><command-args>my new title</command-args>';
  assert.equal(stripAnsi(cleanUserText(input)), '[/rename my new title]');
});

test('cleanUserText: wraps stdout snippets', () => {
  const input = '<local-command-stdout>Enabled foo</local-command-stdout>';
  assert.equal(stripAnsi(cleanUserText(input)), '[stdout] Enabled foo');
});

test('cleanUserText: leaves plain text untouched', () => {
  assert.equal(cleanUserText('Bonjour, comment ça va ?'), 'Bonjour, comment ça va ?');
});

test('cleanUserText: full caveat-only line becomes empty (for title fallback)', () => {
  const input = '<local-command-caveat>Caveat: The messages below were generated...</local-command-caveat>';
  assert.equal(cleanUserText(input), '');
});
