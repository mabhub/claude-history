import os from 'node:os';
import { spawn } from 'node:child_process';
import { readLatestAwaySummary } from './away-summary.mjs';
import { readFirstUserPrompt } from './discover.mjs';
import { cleanUserText } from './transcript.mjs';
import { truncate } from './util.mjs';

const CONTEXT_MAX_CHARS = 2000;
const DEFAULT_TIMEOUT_MS = 60000;

// The whole task lives in the system prompt so the model titles rather than
// converses. Kept as the instruction claude runs under, isolated from any
// project CLAUDE.md / skills (see generateTitle's flags), which otherwise make
// claude digress about the current repo instead of answering.
const TITLE_SYSTEM_PROMPT = [
  'Tu génères un titre court et descriptif pour le texte fourni.',
  'Contraintes : 3 à 10 mots, pas de ponctuation finale, pas de guillemets,',
  'sans préfixe (pas de « Titre : »), sans explication, dans la langue du texte.',
  'Réponds UNIQUEMENT par le titre lui-même, rien d\'autre.',
].join(' ');

/**
 * Build the user prompt sent to `claude -p` (the conversation excerpt). The
 * instructions live in the system prompt; this is just the content to title.
 * Kept pure so it can be unit-tested without spawning anything.
 * @param {string} context - away_summary or a fallback excerpt of the conversation
 * @returns {string} Prompt text
 */
export const buildTitlePrompt = context => context;

// A leading "Titre :" / "Title:" preamble claude sometimes prepends, with or
// without the actual title on the same line.
const PREAMBLE_RE = /^(?:titre|title)\s*:\s*/i;

/**
 * Normalize `claude -p` stdout into a clean title. Walks the lines, strips a
 * "Titre :" / "Title:" preamble (whether it carries the title or sits on its
 * own line), and returns the first line that holds real content — trimmed, with
 * surrounding quotes and trailing sentence punctuation removed.
 * @param {string} stdout - Raw stdout from claude
 * @returns {string} Cleaned title (may be empty)
 */
export const cleanGeneratedTitle = stdout => {
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const deprefixed = line.replace(PREAMBLE_RE, '').trim();
    if (!deprefixed) continue; // preamble-only line ("Titre :") — look further
    // Strip a single layer of surrounding straight or French quotes.
    const unquoted = deprefixed.replace(/^["'«»]\s*/, '').replace(/\s*["'«»]$/, '').trim();
    return unquoted.replace(/[.!?…]+$/, '').trim();
  }
  return '';
};

/**
 * Build the context handed to the LLM: the latest away_summary when present,
 * otherwise the cleaned first user prompt. Truncated to bound the token cost.
 * The transcript itself is never sent — only this short excerpt.
 * @param {string} filePath - Path to the .jsonl transcript
 * @returns {Promise<string>} Context text (may be empty)
 */
export const buildTitleContext = async filePath => {
  const away = await readLatestAwaySummary(filePath);
  if (away) return truncate(away, CONTEXT_MAX_CHARS);
  const prompt = await readFirstUserPrompt(filePath);
  return prompt ? truncate(cleanUserText(prompt), CONTEXT_MAX_CHARS) : '';
};

/**
 * Generate a conversation title with `claude -p`. Builds the context (unless
 * one is supplied to reuse an already-read away_summary), prompts claude,
 * captures stdout, and returns a cleaned title. Rejects on a missing binary,
 * non-zero exit, timeout, or empty output.
 * @param {string} filePath - Path to the .jsonl transcript
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=60000] - Kill claude after this long
 * @param {string} [options.context] - Precomputed context (skips buildTitleContext)
 * @returns {Promise<string>} Cleaned title
 */
export const generateTitle = async (filePath, { timeoutMs = DEFAULT_TIMEOUT_MS, context } = {}) => {
  const ctx = context ?? (await buildTitleContext(filePath));
  if (!ctx) throw new Error('Aucun contenu exploitable pour générer un titre.');
  const prompt = buildTitlePrompt(ctx);
  // Run claude isolated from any project/user customization: a neutral cwd (so
  // it doesn't detect this repo), no setting sources (no CLAUDE.md, skills or
  // hooks), strict MCP (no servers), and the task pinned in --system-prompt.
  // Without this, claude reads the current project's context and digresses
  // instead of returning a bare title.
  const args = [
    '-p', prompt,
    '--system-prompt', TITLE_SYSTEM_PROMPT,
    '--setting-sources', '',
    '--strict-mcp-config',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'ignore'], cwd: os.tmpdir() });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Délai dépassé.'));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude a quitté avec le code ${code}.`));
        return;
      }
      const title = cleanGeneratedTitle(stdout);
      if (!title) {
        reject(new Error('Titre vide.'));
        return;
      }
      resolve(title);
    });
  });
};
