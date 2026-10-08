import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { QUIT, isAbortKey, promptQuittable, promptCancellable } from './prompt-keys.mjs';

/**
 * A stand-in for an Inquirer prompt: settles like the real ones do — rejects
 * with AbortPromptError (cause = signal reason) when its signal aborts.
 * `settle` lets a test resolve or reject it from outside.
 */
const fakePrompt = () => {
  const handle = {};
  handle.prompt = (_config, { signal }) => new Promise((resolve, reject) => {
    handle.settle = { resolve, reject };
    signal.addEventListener('abort', () => {
      const err = new Error('Prompt was aborted');
      err.name = 'AbortPromptError';
      err.cause = signal.reason;
      reject(err);
    });
  });
  return handle;
};

// readline reports a lone Escape with meta: true (verified in a real terminal),
// so the fake must too — modelling it with meta: false hid exactly that bug.
// A prompt that never settles would hang the suite; fail fast instead.
const ASYNC = { timeout: 2000 };

const press = (input, name, mods = {}) =>
  input.emit('keypress', undefined, { name, ctrl: false, meta: name === 'escape', ...mods });

test('isAbortKey: q without modifiers, and escape', () => {
  assert.equal(isAbortKey({ name: 'q' }, ['q', 'escape']), true);
  assert.equal(isAbortKey({ name: 'escape', meta: true }, ['q', 'escape']), true);
  assert.equal(isAbortKey({ name: 'q', ctrl: true }, ['q', 'escape']), false);
  assert.equal(isAbortKey({ name: 'q', meta: true }, ['q', 'escape']), false);
  assert.equal(isAbortKey({ name: 'q' }, ['escape']), false);
  assert.equal(isAbortKey(undefined, ['escape']), false);
});

test('promptQuittable: q and escape resolve to QUIT', ASYNC, async () => {
  for (const key of ['q', 'escape']) {
    const input = new PassThrough();
    const fake = fakePrompt();
    const pending = promptQuittable(fake.prompt, {}, { input });
    press(input, key);
    assert.equal(await pending, QUIT);
  }
});

test('promptQuittable: passes the answer through and ignores Ctrl+Q', ASYNC, async () => {
  const input = new PassThrough();
  const fake = fakePrompt();
  const pending = promptQuittable(fake.prompt, {}, { input });
  press(input, 'q', { ctrl: true });
  fake.settle.resolve('answer');
  assert.equal(await pending, 'answer');
});

test('promptQuittable: Ctrl-C (ExitPromptError) resolves to null', ASYNC, async () => {
  const input = new PassThrough();
  const fake = fakePrompt();
  const pending = promptQuittable(fake.prompt, {}, { input });
  fake.settle.reject(Object.assign(new Error('closed'), { name: 'ExitPromptError' }));
  assert.equal(await pending, null);
});

test('promptCancellable: escape and Ctrl-C resolve to null, q is left to the prompt', ASYNC, async () => {
  const input = new PassThrough();
  const fake = fakePrompt();
  const pending = promptCancellable(fake.prompt, {}, { input });
  press(input, 'q'); // typed text in an input prompt — must not cancel
  press(input, 'escape');
  assert.equal(await pending, null);

  const exit = fakePrompt();
  const exiting = promptCancellable(exit.prompt, {}, { input });
  exit.settle.reject(Object.assign(new Error('closed'), { name: 'ExitPromptError' }));
  assert.equal(await exiting, null);
});

test('promptCancellable: rethrows unrelated errors and detaches its listener', ASYNC, async () => {
  const input = new PassThrough();
  const fake = fakePrompt();
  const before = input.listenerCount('keypress');
  const pending = promptCancellable(fake.prompt, {}, { input });
  fake.settle.reject(new Error('boom'));
  await assert.rejects(pending, /boom/);
  assert.equal(input.listenerCount('keypress'), before);
});
