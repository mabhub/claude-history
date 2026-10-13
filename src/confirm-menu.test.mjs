import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { confirmMenu } from './confirm-menu.mjs';

// A stand-in for listPrompt: records its config and answers `answer`, or
// rejects like Inquirer on Ctrl-C (ExitPromptError) or on q/Escape (abort).
const fakePrompt = answer => {
  const calls = [];
  const prompt = (config, { signal }) => {
    calls.push(config);
    if (answer === 'ctrl-c') return Promise.reject(Object.assign(new Error('exit'), { name: 'ExitPromptError' }));
    if (answer === 'escape') {
      return new Promise((_, reject) => signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortPromptError', cause: signal.reason }));
      }));
    }
    return Promise.resolve(answer);
  };
  return { prompt, calls };
};

// A prompt that never settles would hang the suite; fail fast instead.
const ASYNC = { timeout: 2000 };

test('confirmMenu: offers Oui / Non with the cursor on Non', ASYNC, async () => {
  const { prompt, calls } = fakePrompt(true);
  assert.equal(await confirmMenu('Supprimer ?', { prompt, input: new PassThrough() }), true);
  const [config] = calls;
  assert.equal(config.message, 'Supprimer ?');
  assert.deepEqual(config.choices.map(c => c.value), [true, false]);
  assert.equal(config.default, false);
});

test('confirmMenu: Non, Ctrl-C and Escape all refuse', ASYNC, async () => {
  assert.equal(await confirmMenu('?', { prompt: fakePrompt(false).prompt, input: new PassThrough() }), false);
  assert.equal(await confirmMenu('?', { prompt: fakePrompt('ctrl-c').prompt, input: new PassThrough() }), false);
  const input = new PassThrough();
  const pending = confirmMenu('?', { prompt: fakePrompt('escape').prompt, input });
  // The menu awaits its theme before listening: press once it listens.
  while (input.listenerCount('keypress') === 0) await new Promise(setImmediate);
  input.emit('keypress', undefined, { name: 'escape', ctrl: false, meta: true });
  assert.equal(await pending, false);
});

test('confirmMenu: custom labels replace Oui / Non', ASYNC, async () => {
  const { prompt, calls } = fakePrompt(false);
  await confirmMenu('?', { yes: 'Supprimer', no: 'Garder', prompt, input: new PassThrough() });
  assert.deepEqual(calls[0].choices.map(c => c.name), ['Supprimer', 'Garder']);
});
