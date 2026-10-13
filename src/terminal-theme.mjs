import { execFile } from 'node:child_process';

// Replies to OSC 11 ("what is your background color?"): `rgb:R/G/B`, each
// channel 1 to 4 hex digits, terminated by BEL or ST.
const OSC11_REPLY = /\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)/i;
const QUERY_TIMEOUT_MS = 200;

/**
 * Parse a terminal's reply to an OSC 11 background query.
 * @param {string} text - Raw bytes read from the terminal
 * @returns {Array<number>|null} `[r, g, b]` in 0..1, or null if no reply is found
 */
export const parseOsc11 = text => {
  const match = OSC11_REPLY.exec(text);
  return match ? match.slice(1, 4).map(hex => parseInt(hex, 16) / (16 ** hex.length - 1)) : null;
};

/**
 * Whether a color reads as dark, by its relative luminance.
 * @param {Array<number>} rgb - `[r, g, b]` in 0..1
 * @returns {boolean}
 */
export const isDarkRgb = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;

/**
 * Ask the terminal for its background color (OSC 11). Terminals that don't
 * support it stay silent, so the wait is capped; the tty is put back as found.
 * @param {Object} [io]
 * @param {import('node:tty').ReadStream} [io.input=process.stdin]
 * @param {import('node:tty').WriteStream} [io.output=process.stdout]
 * @returns {Promise<Array<number>|null>} `[r, g, b]` in 0..1, or null
 */
export const queryTerminalBackground = ({ input = process.stdin, output = process.stdout } = {}) =>
  new Promise(resolve => {
    if (!input.isTTY || !output.isTTY) {
      resolve(null);
      return;
    }
    const wasRaw = input.isRaw;
    let received = '';
    const finish = rgb => {
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      resolve(rgb);
    };
    const onData = chunk => {
      received += chunk.toString('latin1');
      const rgb = parseOsc11(received);
      if (rgb) finish(rgb);
    };
    const timer = setTimeout(() => finish(null), QUERY_TIMEOUT_MS);
    input.setRawMode(true);
    input.on('data', onData);
    input.resume();
    output.write('\x1b]11;?\x1b\\');
  });

/**
 * GNOME's light/dark preference, e.g. `'prefer-dark'` (quotes included).
 * @returns {Promise<string|null>} gsettings output, or null when unavailable
 */
export const readGnomeColorScheme = () =>
  new Promise(resolve => {
    execFile('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme'], (err, stdout) =>
      resolve(err ? null : stdout.trim()));
  });

/**
 * Decide whether the terminal is light or dark: `CLH_THEME` (light|dark) if
 * set, else the terminal's own background (OSC 11), else GNOME's preference
 * (as claude-statusline does, which has no tty to ask), else light.
 * @param {Object} [deps] - Injectable sources, for tests
 * @param {Object} [deps.env=process.env]
 * @param {Function} [deps.queryBackground=queryTerminalBackground]
 * @param {Function} [deps.gnomeScheme=readGnomeColorScheme]
 * @returns {Promise<'light'|'dark'>}
 */
export const detectTheme = async ({
  env = process.env,
  queryBackground = queryTerminalBackground,
  gnomeScheme = readGnomeColorScheme,
} = {}) => {
  if (env.CLH_THEME === 'light' || env.CLH_THEME === 'dark') return env.CLH_THEME;
  const rgb = await queryBackground();
  if (rgb) return isDarkRgb(rgb) ? 'dark' : 'light';
  return (await gnomeScheme()) === "'prefer-dark'" ? 'dark' : 'light';
};
