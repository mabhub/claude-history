import {
  createPrompt,
  useState,
  useKeypress,
  usePrefix,
  usePagination,
  useRef,
  makeTheme,
  isEnterKey,
  isUpKey,
  isDownKey,
  Separator,
} from '@inquirer/core';
import pc from 'picocolors';

const CURSOR = '❯';
const CURSOR_HIDE = '\x1b[?25l';

const isChoice = item => !Separator.isSeparator(item);

/**
 * Index of the next choice from `active` in direction `offset`, wrapping
 * around both ends and skipping separators. Pure, so the prompt's navigation
 * is unit-testable without driving a terminal.
 * @param {Array<Object|Separator>} items - Choices and separators
 * @param {number} active - Index of the current choice
 * @param {1|-1} offset - Direction (1 = down, -1 = up)
 * @returns {number} Index of the next choice (`active` itself when it is the only one)
 */
export const nextActiveIndex = (items, active, offset) => {
  let next = active;
  do {
    next = (next + offset + items.length) % items.length;
  } while (!isChoice(items[next]));
  return next;
};

/**
 * Index the prompt starts on: the choice holding `value`, else the first
 * choice (e.g. when the remembered row was just deleted).
 * @param {Array<Object|Separator>} items - Choices and separators
 * @param {unknown} value - Value of the choice to land on
 * @returns {number} Index of a choice
 */
export const initialActiveIndex = (items, value) => {
  const index = items.findIndex(item => isChoice(item) && item.value === value);
  return index === -1 ? items.findIndex(isChoice) : index;
};

const DEFAULT_HELP = [['↑↓', 'naviguer'], ['⏎', 'choisir']];

const helpTip = keys => keys
  .map(([key, action]) => `${pc.bold(key)} ${pc.dim(action)}`)
  .join(pc.dim(' • '));

/**
 * A list prompt modeled on @inquirer/select, plus ← → to change the active
 * choice in place. `@inquirer/select` can neither expose its active item nor
 * take extra keys (it even sends ← → to its type-to-search, which jumps to the
 * top), hence this reduced copy built on the same @inquirer/core hooks.
 *
 * A choice opts in to ← → with `onCycle(step)`: an async callback that applies
 * the change and resolves to the choice's new display name. Keys pressed while
 * a callback runs are ignored, so writes never interleave.
 *
 * A choice can also list `keys` (letter names, e.g. `['d']`): pressing one on
 * that choice ends the prompt with `{ key, value }`, so the caller can run a
 * follow-up prompt (a confirmation) that can't nest inside this one.
 *
 * @param {Object} config
 * @param {string} config.message - Prompt message
 * @param {Array<Object|Separator>} config.choices - `{ name, value, onCycle?, keys? }` or Separator
 * @param {unknown} [config.default] - Value of the initially active choice
 * @param {number} [config.pageSize=7] - Visible rows
 * @param {Array<[string, string]>} [config.help] - Help-line `[key, label]` pairs
 * @param {Object} [config.theme] - Inquirer theme override; `style.highlight` paints the active row
 * @returns {Promise<unknown|{key: string, value: unknown}>} The chosen value, or the key action
 */
export const listPrompt = createPrompt((config, done) => {
  const { pageSize = 7, help = DEFAULT_HELP } = config;
  const theme = makeTheme(config.theme);
  const [status, setStatus] = useState('idle');
  const prefix = usePrefix({ status, theme });
  const [items, setItems] = useState(config.choices);
  const [error, setError] = useState();
  const busy = useRef(false);
  const [active, setActive] = useState(() => initialActiveIndex(items, config.default));
  const current = items[active];

  useKeypress(async (key, rl) => {
    rl.clearLine(0);
    if (busy.current) return;
    setError(undefined);
    if (isEnterKey(key)) {
      setStatus('done');
      done(current.value);
    } else if (isUpKey(key) || isDownKey(key)) {
      setActive(nextActiveIndex(items, active, isUpKey(key) ? -1 : 1));
    } else if (current.keys?.includes(key.name) && !key.ctrl && !key.meta) {
      setStatus('done');
      done({ key: key.name, value: current.value });
    } else if ((key.name === 'left' || key.name === 'right') && current.onCycle) {
      busy.current = true;
      try {
        const name = await current.onCycle(key.name === 'right' ? 1 : -1);
        setItems(items.map((item, i) => (i === active ? { ...item, name } : item)));
      } catch (err) {
        setError(err.message);
      } finally {
        busy.current = false;
      }
    }
  });

  const page = usePagination({
    items,
    active,
    pageSize,
    renderItem: ({ item, isActive }) => {
      if (!isChoice(item)) return ` ${item.separator}`;
      return isActive ? theme.style.highlight(`${CURSOR} ${item.name}`) : `  ${item.name}`;
    },
  });
  const message = theme.style.message(config.message, status);
  if (status === 'done') {
    return [prefix, message, theme.style.answer(current.name)].join(' ');
  }
  const lines = [`${prefix} ${message}`, page, ' ', error ? theme.style.error(error) : '', helpTip(help)]
    .filter(Boolean)
    .join('\n');
  return `${lines}${CURSOR_HIDE}`;
});
