import select from '@inquirer/select';
import input from '@inquirer/input';
import pc from 'picocolors';
import { resolveCwdState } from './resume-cwd.mjs';
import { resumeSession, ensureDir } from './actions.mjs';
import { readSessionContext } from './discover.mjs';
import { encodeCwd, formatAge, formatTokens, cacheStatus } from './util.mjs';
import { promptCancellable } from './prompt-keys.mjs';
import { confirmMenu } from './confirm-menu.mjs';

/**
 * Warning shown before resuming a session whose context left the prompt cache:
 * since when, and how many tokens the resume sends back uncached.
 * @param {{contextTokens: number|null, cacheExpiresAt: Date|null}} context - From readSessionContext
 * @param {number} [now=Date.now()] - Reference epoch (injectable for tests)
 * @returns {string|null} The warning, or null while the cache is warm
 */
export const coldResumeWarning = (context, now = Date.now()) => {
  if (cacheStatus(context, now).warm) return null;
  const since = context.cacheExpiresAt ? ` (expiré ${formatAge(context.cacheExpiresAt, now)})` : '';
  const size = Number.isFinite(context.contextTokens)
    ? `${formatTokens(context.contextTokens)} à recharger`
    : 'taille inconnue';
  return `⚠ Cette conversation n'est plus en cache${since}.\n`
    + `  La reprendre renvoie tout son contexte au prix fort : ${size}.`;
};

/**
 * Before a resume, warn when the context is no longer cached and ask to
 * confirm. Without a TTY there is no one to ask: the resume goes ahead.
 * @param {string} filePath - Path to the session's .jsonl transcript
 * @returns {Promise<boolean>} Whether to go on with the resume
 */
const confirmColdResume = async filePath => {
  if (!process.stdin.isTTY) return true;
  const warning = coldResumeWarning(await readSessionContext(filePath));
  if (!warning) return true;
  console.error(pc.yellow(warning));
  return confirmMenu('Reprendre quand même ?');
};

/**
 * Recreate `cwd` (mkdir -p) then resume in it. Surfaces a mkdir failure as a
 * message and returns 'cancelled' rather than spawning.
 * @param {string} sessionId
 * @param {string} cwd
 * @returns {Promise<'resumed'|'cancelled'>}
 */
const recreateAndResume = async (sessionId, cwd) => {
  try {
    await ensureDir(cwd);
  } catch (err) {
    console.error(pc.red(`⚠ Impossible de créer ${cwd} : ${err.message}`));
    return 'cancelled';
  }
  await resumeSession({ sessionId, cwd });
  return 'resumed';
};

/**
 * Interactive menu shown when the recorded cwd is gone (status 'missing').
 * @param {string} sessionId
 * @param {string} recordedCwd
 * @returns {Promise<'resumed'|'cancelled'>}
 */
const promptMissing = async (sessionId, recordedCwd) => {
  console.error(pc.yellow(`⚠ Le dossier d'origine de cette conversation n'existe plus :\n  ${recordedCwd}`));
  const choice = await promptCancellable(select, {
    message: 'Que faire ?',
    choices: [
      { name: `Recréer ${recordedCwd} et reprendre`, value: 'recreate' },
      { name: 'Déplacer vers un autre dossier… (bientôt)', value: 'move', disabled: true },
      { name: 'Annuler', value: 'cancel' },
    ],
  });
  if (choice === 'recreate') return recreateAndResume(sessionId, recordedCwd);
  return 'cancelled';
};

/**
 * Interactive flow when the transcript carries no cwd (status 'unknown'):
 * let the user confirm/correct an FS-guided guess, create it if needed, and
 * warn if it won't map back to the conversation's storage dir.
 * @param {string} sessionId
 * @param {{encodedDir: string, guess: string|null}} state
 * @returns {Promise<'resumed'|'cancelled'>}
 */
const promptUnknown = async (sessionId, { encodedDir, guess }) => {
  console.error(pc.yellow('⚠ Impossible de lire le dossier d\'origine dans le transcript.'));
  const choice = await promptCancellable(select, {
    message: 'Que faire ?',
    choices: [
      { name: 'Saisir le dossier d\'origine…', value: 'enter' },
      { name: 'Annuler', value: 'cancel' },
    ],
  });
  if (choice !== 'enter') return 'cancelled';

  const entered = await promptCancellable(input, {
    message: 'Dossier d\'origine',
    default: guess ?? '',
  });
  if (!entered) return 'cancelled';

  if (encodeCwd(entered) !== encodedDir) {
    const proceed = await confirmMenu(
      'Ce dossier ne correspond pas à l\'emplacement stocké ; Claude risque de ne pas retrouver la conversation. Continuer ?',
    );
    if (!proceed) return 'cancelled';
  }
  return recreateAndResume(sessionId, entered);
};

/**
 * Resume a session after two checks. When its context is no longer cached,
 * warn of the cost and ask to confirm (see confirmColdResume). Then check its
 * recorded cwd: when it is gone or unknown, drive an interactive recovery menu
 * (recreate / enter path / cancel). Without a TTY there is nothing to prompt:
 * a missing cwd returns 'unavailable' so the caller can print guidance and
 * exit non-zero.
 * @param {Object} options
 * @param {string} options.sessionId - Full session UUID
 * @param {string} options.filePath - Path to the session's .jsonl transcript
 * @returns {Promise<'resumed'|'cancelled'|'unavailable'>}
 */
export const resumeWithChecks = async ({ sessionId, filePath }) => {
  if (!(await confirmColdResume(filePath))) return 'cancelled';
  const state = await resolveCwdState(filePath);
  if (state.status === 'ok') {
    await resumeSession({ sessionId, cwd: state.recordedCwd });
    return 'resumed';
  }
  if (!process.stdin.isTTY) return 'unavailable';
  if (state.status === 'missing') return promptMissing(sessionId, state.recordedCwd);
  return promptUnknown(sessionId, state);
};
