import readline from 'node:readline';
import select, { Separator } from '@inquirer/select';
import input from '@inquirer/input';
import confirm from '@inquirer/confirm';
import pc from 'picocolors';
import { listSessions, findSubProjects, findParentProjects, pathExists } from './discover.mjs';
import { renderTranscript } from './transcript.mjs';
import { renameSession, deleteSession, resumeSession } from './actions.mjs';
import { pipeToViewer, hasGlow, formatDate, MISSING } from './util.mjs';

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

// Visual vocabulary used in the TUI:
//   ● green   custom title set via /rename
//   ● yellow  AI-generated title
//   ○ dim     fallback to the first user prompt
//   ▲ magenta navigation into a parent project
//   ▸ cyan    navigation into a sub-project
//   ⚠ red     missing cwd (see MISSING in util.mjs)
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
const NAV_PREFIX = 'nav:';

/**
 * Run the interactive TUI. Loops until the user quits or chooses to descend
 * into a sub-project (then re-enters itself with the new directory).
 * When `cwd` is null (orphan history), no FS scan is attempted — the view
 * is read-only against the encoded projects dir.
 * @param {Object} options
 * @param {string} options.dir - Claude projects directory for the cwd
 * @param {string|null} options.cwd - Resolved working directory, or null when orphan
 * @param {string} [options.displayLabel] - Override label shown in header (defaults to cwd)
 * @param {boolean} options.walkedUp - Whether we walked up to find sessions
 * @returns {Promise<void>}
 */
export const runInteractive = async ({ dir, cwd, displayLabel, walkedUp }) => {
  while (true) {
    const [sessions, subProjects, parentProjects, cwdMissing] = await Promise.all([
      dir ? listSessions(dir) : Promise.resolve([]),
      cwd ? findSubProjects(cwd) : Promise.resolve([]),
      cwd ? findParentProjects(cwd) : Promise.resolve([]),
      cwd ? pathExists(cwd).then(ok => !ok) : Promise.resolve(true),
    ]);
    if (sessions.length === 0 && subProjects.length === 0 && parentProjects.length === 0) {
      console.log(pc.yellow('Aucune conversation dans ce dossier.'));
      return;
    }

    const headerLabel = displayLabel ?? cwd;
    printHeader({ label: headerLabel, walkedUp, sessionCount: sessions.length, cwdMissing });

    const pageSize = Math.max(5, (process.stdout.rows ?? 20) - 6);
    const choices = buildChoices({ sessions, subProjects, parentProjects });

    const choice = await selectQuittable({
      message: 'Choisir une conversation',
      pageSize,
      choices,
    });

    if (choice === null || choice === QUIT || choice === QUIT_VALUE) return;

    if (choice.startsWith(NAV_PREFIX)) {
      const targetDir = choice.slice(NAV_PREFIX.length);
      const target = [...parentProjects, ...subProjects].find(p => p.dir === targetDir);
      await runInteractive({
        dir: target.dir,
        cwd: target.cwd,
        displayLabel: target.displayLabel,
        walkedUp: false,
      });
      return;
    }

    const session = sessions.find(s => s.sessionId === choice);
    const outcome = await runActionMenu(session);
    if (outcome === EXIT) return;
    // BACK falls through to the next loop iteration, which re-fetches
    // sessions (delete is reflected immediately).
  }
};

const printHeader = ({ label, walkedUp, sessionCount, cwdMissing }) => {
  const suffix = walkedUp ? pc.dim(` (remonté depuis ${process.cwd()})`) : '';
  const missing = cwdMissing ? `  ${MISSING.badge} ${MISSING.label}` : '';
  console.log(`\nConversations dans ${pc.bold(label)}${suffix}  ${pc.dim(`(${sessionCount})`)}${missing}`);
  console.log(pc.dim(`Légende : ${LEGEND}  ·  q pour quitter`));
  console.log('');
};

const formatNavChoice = ({ entry, icon, displayPath }) => {
  const arrow = entry.missing ? MISSING.badge : icon;
  const label = entry.missing
    ? pc.strikethrough(displayPath)
    : pc.bold(displayPath);
  const suffix = entry.missing ? `  ${MISSING.label}` : '';
  return {
    name: `${arrow} ${label}  ${pc.dim(`(${entry.sessionCount} conversations)`)}${suffix}`,
    value: `${NAV_PREFIX}${entry.dir}`,
  };
};

const buildChoices = ({ sessions, subProjects, parentProjects }) => {
  const choices = [];
  if (parentProjects.length > 0) {
    choices.push(new Separator(pc.dim('— Dossiers parents avec historique —')));
    for (const parent of parentProjects) {
      choices.push(formatNavChoice({
        entry: parent,
        icon: pc.magenta('▲'),
        displayPath: parent.displayLabel,
      }));
    }
  }
  if (subProjects.length > 0) {
    choices.push(new Separator(pc.dim('— Sous-dossiers avec historique —')));
    for (const sub of subProjects) {
      const displayPath = sub.missing ? sub.displayLabel : relativePath(sub.displayLabel);
      choices.push(formatNavChoice({
        entry: sub,
        icon: pc.cyan('▸'),
        displayPath,
      }));
    }
  }
  if ((parentProjects.length > 0 || subProjects.length > 0) && sessions.length > 0) {
    choices.push(new Separator(pc.dim('— Conversations du dossier courant —')));
  }
  for (const s of sessions) {
    choices.push({ name: formatChoice(s), value: s.sessionId });
  }
  choices.push(new Separator(' '));
  choices.push({ name: pc.dim('Quitter'), value: QUIT_VALUE });
  return choices;
};

const relativePath = absPath => {
  const cwd = process.cwd();
  if (absPath.startsWith(`${cwd}/`)) return `./${absPath.slice(cwd.length + 1)}`;
  return absPath;
};

const formatChoice = s => {
  const idShort = pc.dim(s.sessionId.slice(0, 8));
  const date = pc.cyan(formatDate(s.mtime));
  const title = s.title === '(sans titre)' ? pc.dim(s.title) : s.title;
  const badge = TITLE_SOURCE_BADGES[s.titleSource] ?? pc.dim('○');
  return `${badge} ${idShort}  ${date}  ${title}`;
};

// Action handlers return one of:
//   'submenu' : stay on the per-session action menu (re-display it)
//   'list'    : go back to the conversation list
//   'exit'    : quit the whole TUI
const STAY = 'submenu';
const BACK = 'list';
const EXIT = 'exit';

const viewTranscript = async (session, { raw }) => {
  const useMarkdown = !raw && hasGlow();
  const text = await renderTranscript({
    filePath: session.filePath,
    raw,
    style: useMarkdown ? 'markdown' : 'ansi',
  });
  await pipeToViewer({ text, markdown: useMarkdown });
  return STAY;
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
  return STAY;
};

const deleteAction = async session => {
  const ok = await confirm({
    message: `Supprimer définitivement "${session.title}" ?`,
    default: false,
  }).catch(handleCancel);
  if (!ok) return STAY;
  const { removedDir } = await deleteSession({
    filePath: session.filePath,
    sessionId: session.sessionId,
  });
  console.log(pc.green(`✓ Supprimé${removedDir ? ' (+ dossier associé)' : ''}`));
  // Session no longer exists — fall back to the refreshed list.
  return BACK;
};

const resumeAction = async session => {
  await resumeSession(session.sessionId);
  return EXIT;
};

const ACTION_HANDLERS = {
  view: session => viewTranscript(session, { raw: false }),
  'view-raw': session => viewTranscript(session, { raw: true }),
  rename: renameAction,
  delete: deleteAction,
  resume: resumeAction,
};

const runActionMenu = async session => {
  while (true) {
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

    if (action === QUIT || action === 'back') return BACK;
    if (action === null || action === 'quit') return EXIT;

    const outcome = await ACTION_HANDLERS[action](session);
    if (outcome === BACK) return BACK;
    if (outcome === EXIT) return EXIT;
    // outcome === STAY: loop and re-display the action menu for this session.
  }
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
