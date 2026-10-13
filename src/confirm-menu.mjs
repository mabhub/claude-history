import { listPrompt } from './list-prompt.mjs';
import { QUIT, promptQuittable } from './prompt-keys.mjs';
import { activeRowTheme } from './terminal-theme.mjs';

const CONFIRM_HELP = [['↑↓', 'choisir'], ['⏎', 'valider'], ['q/Échap', 'non']];

/**
 * Ask a yes/no question as a two-item menu, the cursor on the "no" item, so
 * the arrows already under the hand answer it — instead of typing y/N.
 * `q`, Escape and Ctrl-C all mean no.
 * @param {string} message - The question
 * @param {Object} [options]
 * @param {string} [options.yes='Oui'] - "Yes" label (may be colored)
 * @param {string} [options.no='Non'] - "No" label
 * @param {Function} [options.prompt=listPrompt] - Injectable for tests
 * @param {NodeJS.ReadableStream} [options.input=process.stdin] - Injectable for tests
 * @returns {Promise<boolean>} True only on the "yes" item
 */
export const confirmMenu = async (message, { yes = 'Oui', no = 'Non', prompt = listPrompt, input = process.stdin } = {}) => {
  const answer = await promptQuittable(prompt, {
    message,
    choices: [{ name: yes, value: true }, { name: no, value: false }],
    default: false,
    help: CONFIRM_HELP,
    theme: await activeRowTheme(),
  }, { input });
  return answer !== QUIT && answer === true;
};
