import select from '@inquirer/select';
import input from '@inquirer/input';
import confirm from '@inquirer/confirm';
import pc from 'picocolors';
import { listSessions } from './discover.mjs';
import { renderTranscript } from './transcript.mjs';
import { renameSession, deleteSession, resumeSession } from './actions.mjs';
import { pipeToPager, formatDate } from './util.mjs';

/**
 * Run the interactive TUI: choose a conversation, then pick an action on it.
 * Loops until the user quits.
 * @param {Object} options
 * @param {string} options.dir - Claude projects directory for the cwd
 * @param {string} options.cwd - Resolved working directory
 * @param {boolean} options.walkedUp - Whether we walked up to find sessions
 * @returns {Promise<void>}
 */
export const runInteractive = async ({ dir, cwd, walkedUp }) => {
  while (true) {
    const sessions = await listSessions(dir);
    if (sessions.length === 0) {
      console.log(pc.yellow('Aucune conversation dans ce dossier.'));
      return;
    }

    const header = walkedUp
      ? `Conversations dans ${pc.bold(cwd)} ${pc.dim(`(remonté depuis ${process.cwd()})`)}`
      : `Conversations dans ${pc.bold(cwd)}`;
    console.log(`\n${header}  ${pc.dim(`(${sessions.length})`)}\n`);

    const pageSize = Math.max(5, (process.stdout.rows ?? 20) - 6);

    const chosenId = await select({
      message: 'Choisir une conversation',
      pageSize,
      loop: false,
      choices: sessions.map(s => ({
        name: formatChoice(s),
        value: s.sessionId,
      })).concat([{ name: pc.dim('— Quitter'), value: '__quit__' }]),
    }).catch(handleCancel);
    if (!chosenId || chosenId === '__quit__') return;

    const session = sessions.find(s => s.sessionId === chosenId);
    const keepGoing = await runActionMenu(session);
    if (!keepGoing) return;
  }
};

const TITLE_SOURCE_BADGES = {
  custom: pc.green('●'),
  ai: pc.yellow('●'),
  prompt: pc.dim('○'),
};

const formatChoice = s => {
  const idShort = pc.dim(s.sessionId.slice(0, 8));
  const date = pc.cyan(formatDate(s.mtime));
  const title = s.title === '(sans titre)' ? pc.dim(s.title) : s.title;
  const badge = TITLE_SOURCE_BADGES[s.titleSource] ?? pc.dim('○');
  return `${badge} ${idShort}  ${date}  ${title}`;
};

const viewTranscript = async (session, { raw }) => {
  const text = await renderTranscript({ filePath: session.filePath, raw });
  await pipeToPager(text);
  return true;
};

const renameAction = async session => {
  const title = await input({
    message: 'Nouveau titre',
    default: session.titleSource === 'custom' ? session.title : '',
  }).catch(handleCancel);
  if (title) {
    await renameSession({
      filePath: session.filePath,
      sessionId: session.sessionId,
      title,
    });
    console.log(pc.green(`✓ Renommé: ${title}`));
  }
  return true;
};

const deleteAction = async session => {
  const ok = await confirm({
    message: `Supprimer définitivement "${session.title}" ?`,
    default: false,
  }).catch(handleCancel);
  if (ok) {
    const { removedDir } = await deleteSession({
      filePath: session.filePath,
      sessionId: session.sessionId,
    });
    console.log(pc.green(`✓ Supprimé${removedDir ? ' (+ dossier associé)' : ''}`));
  }
  return true;
};

const resumeAction = async session => {
  await resumeSession(session.sessionId);
  return false;
};

const ACTION_HANDLERS = {
  view: session => viewTranscript(session, { raw: false }),
  'view-raw': session => viewTranscript(session, { raw: true }),
  rename: renameAction,
  delete: deleteAction,
  resume: resumeAction,
  back: () => true,
  quit: () => false,
};

const runActionMenu = async session => {
  const action = await select({
    message: `${session.sessionId.slice(0, 8)} — ${session.title}`,
    choices: [
      { name: 'Voir le transcript', value: 'view' },
      { name: 'Voir le transcript (brut JSONL)', value: 'view-raw' },
      { name: 'Renommer', value: 'rename' },
      { name: 'Supprimer', value: 'delete' },
      { name: 'Reprendre (claude --resume)', value: 'resume' },
      { name: pc.dim('← Retour à la liste'), value: 'back' },
      { name: pc.dim('Quitter'), value: 'quit' },
    ],
  }).catch(handleCancel);

  if (!action) return false;
  return ACTION_HANDLERS[action](session);
};

/**
 * Inquirer rejects with an Error on Ctrl-C. Treat as graceful cancel.
 * @param {unknown} err - Error from Inquirer
 * @returns {null}
 */
const handleCancel = err => {
  if (err?.name === 'ExitPromptError') return null;
  throw err;
};
