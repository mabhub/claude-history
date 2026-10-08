import os from 'node:os';
import { spawn } from 'node:child_process';
import { readLatestAwaySummary } from './away-summary.mjs';
import { readFirstUserPrompt } from './discover.mjs';
import { cleanUserText } from './transcript.mjs';
import { truncate } from './util.mjs';

const CONTEXT_MAX_CHARS = 2000;
const DEFAULT_TIMEOUT_MS = 60000;

// Common, language-exclusive function words. Technical terms (ssh, deploy,
// build) are shared, so counting these — not content words — is what makes
// detection robust on short, jargon-heavy summaries. Words common to both
// languages ("a" is also French "has", "on" is French too) are left out: they
// tipped plain French into English. Boundaries are Unicode letters, since `\b`
// is ASCII-only and never matched after "où".
const FR_WORDS = /(?<!\p{L})(?:le|la|les|un|une|des|du|de|et|est|dans|pour|avec|sur|par|que|qui|au|aux|ce|cette|ne|pas|plus|son|ses|où)(?!\p{L})/giu;
const EN_WORDS = /(?<!\p{L})(?:the|an|of|and|is|are|in|for|with|by|that|which|to|this|these|not|more|its|where|was|were)(?!\p{L})/giu;

/**
 * Detect the dominant language of a text as 'fr' or 'en' by counting common
 * function words. Defaults to 'fr' (the user's language) when nothing matches,
 * so titles never silently drift to English on ambiguous input.
 * @param {string} text - Text to classify
 * @returns {'fr'|'en'}
 */
export const detectLanguage = text => {
  const fr = (text.match(FR_WORDS) || []).length;
  const en = (text.match(EN_WORDS) || []).length;
  if (en > fr) return 'en';
  return 'fr';
};

/**
 * Build the system prompt for `claude -p`, pinning the output language so the
 * model doesn't infer it (unreliable on jargon-heavy text). The whole task
 * lives here so the model titles rather than converses.
 * @param {'fr'|'en'} lang - Language the title must be written in
 * @returns {string} System prompt
 */
export const buildSystemPrompt = lang => {
  const langLabel = lang === 'en' ? 'anglais' : 'français';
  return [
    'Tu es un générateur de titres.',
    'Ta réponse doit contenir EXACTEMENT une ligne : le titre lui-même.',
    `Le titre DOIT être rédigé en ${langLabel}.`,
    'Contraintes : 3 à 10 mots, pas de ponctuation finale, pas de guillemets.',
    'N\'écris AUCUNE phrase avant ou après le titre :',
    'pas de préambule, pas de « Titre : », pas d\'explication.',
  ].join(' ');
};

// A leading "Titre :" / "Title:" preamble claude sometimes prepends on the
// same line as the title.
const PREAMBLE_RE = /^(?:titre|title)\s*:\s*/i;

/**
 * Normalize `claude -p` stdout into a clean title. claude often prepends a
 * chatty preamble ("Titre court demandé.", "Voici un titre :") on its own line
 * before the real title, so we take the LAST non-empty line — empirically the
 * actual answer, whether the output is one line or several. That line is then
 * de-prefixed, unquoted, and stripped of trailing sentence punctuation.
 * @param {string} stdout - Raw stdout from claude
 * @returns {string} Cleaned title (may be empty)
 */
export const cleanGeneratedTitle = stdout => {
  const last = stdout.split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? '';
  const deprefixed = last.replace(PREAMBLE_RE, '').trim();
  // Strip a single layer of surrounding straight or French quotes.
  const unquoted = deprefixed.replace(/^["'«»]\s*/, '').replace(/\s*["'«»]$/, '').trim();
  return unquoted.replace(/[.!?…]+$/, '').trim();
};

/**
 * Build the error message for a failed `claude -p` run. The last non-empty
 * stderr line carries the actual reason (e.g. "error: unknown option …");
 * without it, failures were reported as a bare exit code.
 * @param {number|null} code - Exit code
 * @param {string} stderr - Captured stderr
 * @returns {string} User-facing message
 */
export const describeExitFailure = (code, stderr) => {
  const reason = stderr.split('\n').map(l => l.trim()).filter(Boolean).at(-1);
  return reason
    ? `claude a quitté avec le code ${code} : ${truncate(reason, 200)}`
    : `claude a quitté avec le code ${code}.`;
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
 * non-zero exit (with claude's stderr reason), timeout, or empty output.
 * @param {string} filePath - Path to the .jsonl transcript
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=60000] - Kill claude after this long
 * @param {string} [options.context] - Precomputed context (skips buildTitleContext)
 * @returns {Promise<string>} Cleaned title
 */
export const generateTitle = async (filePath, { timeoutMs = DEFAULT_TIMEOUT_MS, context } = {}) => {
  const ctx = context ?? (await buildTitleContext(filePath));
  if (!ctx) throw new Error('Aucun contenu exploitable pour générer un titre.');
  // Pin the title's language to the context's own, rather than let the model
  // infer it — inference drifts to English on short, jargon-heavy summaries.
  const systemPrompt = buildSystemPrompt(detectLanguage(ctx));
  // Run claude isolated and lean for a one-shot, no-tools title:
  //   - neutral cwd + no setting sources + strict MCP: don't pick up this repo's
  //     CLAUDE.md / skills, which otherwise make claude digress about the project
  //   - task pinned in --system-prompt
  //   - --no-session-persistence: this throwaway run must not clutter the session
  //     history (which clh itself lists)
  //   - --max-turns 1 + --tools '': a single turn, no tool use — nothing to read
  //     or act on, just answer. Bounds tokens and keeps it deterministic.
  //   - the prompt goes after `--`: -p is a flag, the prompt a positional, so a
  //     context starting with "-" (a pasted bullet list) was parsed as an option
  // (Default model kept: measured faster here than haiku for this short task.)
  const args = [
    '-p',
    '--system-prompt', systemPrompt,
    '--setting-sources', '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--max-turns', '1',
    '--tools', '',
    '--', ctx,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: os.tmpdir() });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Délai dépassé.'));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(describeExitFailure(code, stderr)));
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
