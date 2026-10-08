import readline from 'node:readline';

/**
 * Sentinel returned by promptQuittable when the user pressed `q` or Escape.
 * Callers compare with === to distinguish from normal prompt values.
 */
export const QUIT = Symbol('quit');

// readline waits this long after a lone ESC byte before deciding it is the
// Escape key rather than the start of an arrow sequence. Its default (500 ms)
// makes Escape feel broken; 50 ms still parses arrows split across packets.
const ESCAPE_TIMEOUT_MS = 50;

const LIST_ABORT_KEYS = ['q', 'escape'];
const INPUT_ABORT_KEYS = ['escape'];

/**
 * Whether a keypress is one of `keys`. A letter like `q` only counts without
 * Ctrl/Meta, so Ctrl+Q or Alt+Q stay with the terminal. Escape is exempt:
 * readline always reports a lone Escape with `meta: true`.
 * @param {{name?: string, ctrl?: boolean, meta?: boolean}|undefined} key - readline key event
 * @param {Array<string>} keys - Key names that abort
 * @returns {boolean}
 */
export const isAbortKey = (key, keys) =>
  Boolean(key) && keys.includes(key.name) && (key.name === 'escape' || (!key.ctrl && !key.meta));

/**
 * Run an Inquirer prompt that `keys` abort. Installs the keypress decoder first
 * (the first install wins, so it must precede any Inquirer prompt) with a short
 * Escape timeout.
 * @param {Function} prompt - Inquirer prompt taking `(config, { signal, input })`
 * @param {Object} config - Prompt config
 * @param {Array<string>} keys - Key names that abort
 * @param {NodeJS.ReadableStream} input - Stream the prompt reads (stdin; injectable for tests)
 * @returns {Promise<unknown|typeof QUIT|null>} Answer, QUIT on an abort key, null on Ctrl-C
 */
const runWithAbortKeys = async (prompt, config, keys, input) => {
  readline.emitKeypressEvents(input, { escapeCodeTimeout: ESCAPE_TIMEOUT_MS });
  const controller = new AbortController();
  const onKey = (_, key) => {
    if (isAbortKey(key, keys)) controller.abort('quit');
  };
  input.on('keypress', onKey);
  try {
    return await prompt(config, { signal: controller.signal, input });
  } catch (err) {
    if (err?.name === 'AbortPromptError' && err.cause === 'quit') return QUIT;
    if (err?.name === 'ExitPromptError') return null;
    throw err;
  } finally {
    input.off('keypress', onKey);
  }
};

/**
 * Run a list menu where `q` and Escape go back (or quit, at the top level).
 * Only for list menus — in a text input, `q` must stay a typed character.
 * @param {Function} prompt - Inquirer prompt (select, listPrompt, …)
 * @param {Object} config - Prompt config
 * @param {Object} [options]
 * @param {NodeJS.ReadableStream} [options.input=process.stdin] - Injectable for tests
 * @returns {Promise<unknown|typeof QUIT|null>} Answer, QUIT on q/Escape, null on Ctrl-C
 */
export const promptQuittable = (prompt, config, { input = process.stdin } = {}) =>
  runWithAbortKeys(prompt, config, LIST_ABORT_KEYS, input);

/**
 * Run a text input, a confirmation or a one-off menu where Escape cancels.
 * Escape and Ctrl-C both resolve to null, the callers' existing "cancelled".
 * @param {Function} prompt - Inquirer prompt (input, confirm, select, …)
 * @param {Object} config - Prompt config
 * @param {Object} [options]
 * @param {NodeJS.ReadableStream} [options.input=process.stdin] - Injectable for tests
 * @returns {Promise<unknown|null>} Answer, or null when cancelled
 */
export const promptCancellable = async (prompt, config, { input = process.stdin } = {}) => {
  const answer = await runWithAbortKeys(prompt, config, INPUT_ABORT_KEYS, input);
  return answer === QUIT ? null : answer;
};
