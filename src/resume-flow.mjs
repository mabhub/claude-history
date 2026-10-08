import select from '@inquirer/select';
import input from '@inquirer/input';
import confirm from '@inquirer/confirm';
import pc from 'picocolors';
import { resolveCwdState } from './resume-cwd.mjs';
import { resumeSession, ensureDir } from './actions.mjs';
import { encodeCwd } from './util.mjs';
import { promptCancellable } from './prompt-keys.mjs';

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
    const proceed = await promptCancellable(confirm, {
      message: 'Ce dossier ne correspond pas à l\'emplacement stocké ; Claude risque de ne pas retrouver la conversation. Continuer ?',
      default: false,
    });
    if (!proceed) return 'cancelled';
  }
  return recreateAndResume(sessionId, entered);
};

/**
 * Resume a session, checking its recorded cwd first. When the cwd is gone or
 * unknown, drive an interactive recovery menu (recreate / enter path / cancel).
 * Without a TTY there is nothing to prompt: returns 'unavailable' so the caller
 * can print guidance and exit non-zero.
 * @param {Object} options
 * @param {string} options.sessionId - Full session UUID
 * @param {string} options.filePath - Path to the session's .jsonl transcript
 * @returns {Promise<'resumed'|'cancelled'|'unavailable'>}
 */
export const resumeWithCwdCheck = async ({ sessionId, filePath }) => {
  const state = await resolveCwdState(filePath);
  if (state.status === 'ok') {
    await resumeSession({ sessionId, cwd: state.recordedCwd });
    return 'resumed';
  }
  if (!process.stdin.isTTY) return 'unavailable';
  if (state.status === 'missing') return promptMissing(sessionId, state.recordedCwd);
  return promptUnknown(sessionId, state);
};
