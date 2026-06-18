import readline from 'node:readline';
import select, { Separator } from '@inquirer/select';
import input from '@inquirer/input';
import confirm from '@inquirer/confirm';
import pc from 'picocolors';
import { listSessions, findSubProjects } from './discover.mjs';
import { renderTranscript } from './transcript.mjs';
import { renameSession, deleteSession, resumeSession } from './actions.mjs';
import { pipeToViewer, hasGlow, formatDate } from './util.mjs';

/**
 * Sentinel returned by selectQuittable when the user pressed `q`.
 * Callers compare with === to distinguish from normal select values.
 */
export const QUIT = Symbol('quit');

/**
 * Run @inquirer/select with an extra global keybinding: pressing `q` aborts
 * the prompt and returns the QUIT sentinel. Ctrl-C still works as usual
 * (handled by Inquirer itself, surfaces as ExitPromptError → null).
 *
 * Only attach this on list menus — using it around `input` would steal the
 * `q` keystroke from the typed text.
 *
 * @param {Object} config - Same shape as @inquirer/select's config
 * @returns {Promise<unknown|typeof QUIT|null>} Selected value, QUIT, or null on Ctrl-C
 */
const selectQuittable = async config => {
  readline.emitKeypressEvents(process.stdin);
  const controller = new AbortController();
  const onKey = (_, key) => {
    if (key?.name === 'q' && !key.ctrl && !key.meta) {
      controller.abort('quit');
    }
  };
  process.stdin.on('keypress', onKey);
  try {
    return await select(config, { signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortPromptError' && err.cause === 'quit') return QUIT;
    if (err?.name === 'ExitPromptError') return null;
    throw err;
  } finally {
    process.stdin.off('keypress', onKey);
  }
};

const TITLE_SOURCE_BADGES = {
  custom: pc.green('●'),
  ai: pc.yellow('●'),
  prompt: pc.dim('○'),
};

const LEGEND = [
  `${TITLE_SOURCE_BADGES.custom} titre /rename`,
  `${TITLE_SOURCE_BADGES.ai} titre auto`,
  `${TITLE_SOURCE_BADGES.prompt} 1ʳᵉ requête`,
].join(pc.dim(' · '));

const QUIT_VALUE = '__quit__';
const SUB_PREFIX = 'sub:';

/**
 * Run the interactive TUI. Loops until the user quits or chooses to descend
 * into a sub-project (then re-enters itself with the new directory).
 * @param {Object} options
 * @param {string} options.dir - Claude projects directory for the cwd
 * @param {string} options.cwd - Resolved working directory
 * @param {boolean} options.walkedUp - Whether we walked up to find sessions
 * @returns {Promise<void>}
 */
export const runInteractive = async ({ dir, cwd, walkedUp }) => {
  while (true) {
    const [sessions, subProjects] = await Promise.all([
      dir ? listSessions(dir) : Promise.resolve([]),
      findSubProjects(cwd),
    ]);
    if (sessions.length === 0 && subProjects.length === 0) {
      console.log(pc.yellow('Aucune conversation dans ce dossier.'));
      return;
    }

    printHeader({ cwd, walkedUp, sessionCount: sessions.length });

    const pageSize = Math.max(5, (process.stdout.rows ?? 20) - 6);
    const choices = buildChoices({ sessions, subProjects });

    const choice = await selectQuittable({
      message: 'Choisir une conversation',
      pageSize,
      choices,
    });

    if (choice === null || choice === QUIT || choice === QUIT_VALUE) return;

    if (choice.startsWith(SUB_PREFIX)) {
      const subCwd = choice.slice(SUB_PREFIX.length);
      const sub = subProjects.find(s => s.cwd === subCwd);
      await runInteractive({ dir: sub.dir, cwd: sub.cwd, walkedUp: false });
      return;
    }

    const session = sessions.find(s => s.sessionId === choice);
    const keepGoing = await runActionMenu(session);
    if (!keepGoing) return;
  }
};

const printHeader = ({ cwd, walkedUp, sessionCount }) => {
  const suffix = walkedUp ? pc.dim(` (remonté depuis ${process.cwd()})`) : '';
  console.log(`\nConversations dans ${pc.bold(cwd)}${suffix}  ${pc.dim(`(${sessionCount})`)}`);
  console.log(pc.dim(`Légende : ${LEGEND}  ·  q pour quitter`));
  console.log('');
};

const buildChoices = ({ sessions, subProjects }) => {
  const choices = [];
  if (subProjects.length > 0) {
    choices.push(new Separator(pc.dim('— Sous-dossiers avec historique —')));
    for (const sub of subProjects) {
      const rel = relativePath(sub.cwd);
      choices.push({
        name: `${pc.cyan('▸')} ${pc.bold(rel)}  ${pc.dim(`(${sub.sessionCount} conversations)`)}`,
        value: `${SUB_PREFIX}${sub.cwd}`,
      });
    }
    choices.push(new Separator(pc.dim('— Conversations du dossier courant —')));
  }
  for (const s of sessions) {
    choices.push({ name: formatChoice(s), value: s.sessionId });
  }
  choices.push(new Separator(' '));
  choices.push({ name: pc.dim('Quitter'), value: QUIT_VALUE });
  return choices;
};

const relativePath = subCwd => {
  const cwd = process.cwd();
  if (subCwd.startsWith(`${cwd}/`)) return `./${subCwd.slice(cwd.length + 1)}`;
  return subCwd;
};

const formatChoice = s => {
  const idShort = pc.dim(s.sessionId.slice(0, 8));
  const date = pc.cyan(formatDate(s.mtime));
  const title = s.title === '(sans titre)' ? pc.dim(s.title) : s.title;
  const badge = TITLE_SOURCE_BADGES[s.titleSource] ?? pc.dim('○');
  return `${badge} ${idShort}  ${date}  ${title}`;
};

const viewTranscript = async (session, { raw }) => {
  const useMarkdown = !raw && hasGlow();
  const text = await renderTranscript({
    filePath: session.filePath,
    raw,
    style: useMarkdown ? 'markdown' : 'ansi',
  });
  await pipeToViewer({ text, markdown: useMarkdown });
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
  const action = await selectQuittable({
    message: `${session.sessionId.slice(0, 8)} — ${session.title}`,
    choices: [
      { name: 'Voir le transcript', value: 'view' },
      { name: 'Voir le transcript (brut JSONL)', value: 'view-raw' },
      { name: 'Renommer', value: 'rename' },
      { name: 'Supprimer', value: 'delete' },
      { name: 'Reprendre (claude --resume)', value: 'resume' },
      { name: pc.dim(`← Retour à la liste ${pc.dim('(q)')}`), value: 'back' },
      { name: pc.dim('Quitter'), value: 'quit' },
    ],
  });

  // `q` here means "back to the list", not "quit the whole TUI".
  if (action === QUIT || action === 'back') return true;
  if (action === null || action === 'quit') return false;
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
