import readline from 'node:readline';
import select, { Separator } from '@inquirer/select';
import input from '@inquirer/input';
import confirm from '@inquirer/confirm';
import pc from 'picocolors';
import { listSessions, findSubProjects, findParentProjects, pathExists } from './discover.mjs';
import { renderTranscript } from './transcript.mjs';
import { renameSession, deleteSession } from './actions.mjs';
import { resumeWithCwdCheck } from './resume-flow.mjs';
import { readLatestAwaySummary } from './away-summary.mjs';
import { generateTitle } from './title-gen.mjs';
import { pipeToViewer, hasGlow, formatSessionRow, truncate, MISSING } from './util.mjs';

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

// Away-summary cache for the lifetime of the TUI process: sessionId → summary
// (null once scanned and absent). Avoids rescanning a revisited session.
const awayCache = new Map();

/**
 * Get a session's away_summary, memoized. Reads it once per session.
 * @param {string} sessionId - Full session UUID
 * @param {string} filePath - Path to the session's .jsonl transcript
 * @returns {Promise<string|null>}
 */
const getAway = async (sessionId, filePath) => {
  if (awayCache.has(sessionId)) return awayCache.get(sessionId);
  const away = await readLatestAwaySummary(filePath);
  awayCache.set(sessionId, away);
  return away;
};

/** Sentinel: the away scan hasn't resolved yet (used to race it against a delay). */
const PENDING = Symbol('pending');
/** Resolve after `ms` with the PENDING sentinel. */
const delayPending = ms => new Promise(resolve => { setTimeout(() => resolve(PENDING), ms); });

const AWAY_ANNEX_MAX = 200;
const AWAY_RACE_MS = 200;

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
  const badge = TITLE_SOURCE_BADGES[s.titleSource] ?? pc.dim('○');
  return `${badge} ${formatSessionRow(s)}`;
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

const renameAction = async (session, away) => {
  if (away) console.log(pc.dim(`Résumé : ${truncate(away, AWAY_ANNEX_MAX)}`));
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
  const outcome = await resumeWithCwdCheck({ sessionId: session.sessionId, filePath: session.filePath });
  // 'unavailable' can't happen in the TUI (it implies a TTY). 'cancelled' or a
  // failed mkdir returns to the list; a successful resume never returns here.
  return outcome === 'cancelled' ? BACK : EXIT;
};

/**
 * Ask Claude for a title (via generateTitle), then let the user accept, edit,
 * regenerate, or cancel before it is written. `away` is the cached summary, if
 * any, reused as context so no second scan happens.
 * @param {Object} session - Session record
 * @param {string|null} away - Cached away_summary, or null
 * @returns {Promise<'submenu'>}
 */
const generateTitleAction = async (session, away) => {
  const propose = async () => {
    console.log(pc.dim('⏳ Génération du titre via Claude…'));
    return generateTitle(session.filePath, { context: away ?? undefined });
  };
  let title;
  try {
    title = await propose();
  } catch (err) {
    console.error(pc.red(`⚠ Échec : ${err.message}`));
    return STAY;
  }
  while (true) {
    const choice = await selectQuittable({
      message: `Titre proposé : ${pc.bold(title)}`,
      choices: [
        { name: 'Accepter', value: 'accept' },
        { name: 'Éditer', value: 'edit' },
        { name: 'Regénérer', value: 'regen' },
        { name: pc.dim('Annuler'), value: 'cancel' },
      ],
    });
    if (choice === 'accept') {
      await renameSession({ filePath: session.filePath, sessionId: session.sessionId, title });
      console.log(pc.green(`✓ Renommé: ${title}`));
      return STAY;
    }
    if (choice === 'edit') {
      const edited = await input({ message: 'Titre', default: title }).catch(handleCancel);
      if (edited) {
        await renameSession({ filePath: session.filePath, sessionId: session.sessionId, title: edited });
        console.log(pc.green(`✓ Renommé: ${edited}`));
      }
      return STAY;
    }
    if (choice === 'regen') {
      try {
        title = await propose();
      } catch (err) {
        console.error(pc.red(`⚠ Échec : ${err.message}`));
        return STAY;
      }
      continue;
    }
    return STAY; // cancel, QUIT, or null
  }
};

/**
 * Dispatch a menu action to its handler. Separated from the menu loop so the
 * two away-aware handlers (rename, generate) receive the summary explicitly.
 * @param {string} action - Selected menu value
 * @param {Object} session - Session record
 * @param {string|null} away - Cached away_summary, or null
 * @returns {Promise<'submenu'|'list'|'exit'>}
 */
const runAction = (action, session, away) => {
  if (action === 'view') return viewTranscript(session, { raw: false });
  if (action === 'view-raw') return viewTranscript(session, { raw: true });
  if (action === 'rename') return renameAction(session, away);
  if (action === 'generate') return generateTitleAction(session, away);
  if (action === 'delete') return deleteAction(session);
  if (action === 'resume') return resumeAction(session);
  return Promise.resolve(STAY);
};

const runActionMenu = async session => {
  // Kick off the away scan; race a short delay so the menu never blocks but the
  // annex shows on the first paint when the scan is quick.
  const awayPromise = getAway(session.sessionId, session.filePath);
  let awayResolved = await Promise.race([awayPromise, delayPending(AWAY_RACE_MS)]);
  while (true) {
    // On later paints the scan has settled — reflect it from the cache.
    if (awayResolved === PENDING && awayCache.has(session.sessionId)) {
      awayResolved = awayCache.get(session.sessionId);
    }
    const away = awayResolved === PENDING ? null : awayResolved;
    const annex = awayResolved === PENDING
      ? pc.dim('⏳ Résumé en cours de lecture…')
      : (away ? pc.dim(truncate(away, AWAY_ANNEX_MAX)) : '');
    const message = annex
      ? `${session.sessionId.slice(0, 8)} — ${session.title}\n  ${annex}`
      : `${session.sessionId.slice(0, 8)} — ${session.title}`;

    const action = await selectQuittable({
      message,
      choices: [
        { name: 'Voir le transcript', value: 'view' },
        { name: 'Voir le transcript (brut JSONL)', value: 'view-raw' },
        { name: 'Renommer', value: 'rename' },
        { name: 'Générer un titre (Claude)', value: 'generate' },
        { name: 'Supprimer', value: 'delete' },
        { name: 'Reprendre (claude --resume)', value: 'resume' },
        { name: pc.dim(`← Retour à la liste ${pc.dim('(q)')}`), value: 'back' },
        { name: pc.dim('Quitter'), value: 'quit' },
      ],
    });

    if (action === QUIT || action === 'back') return BACK;
    if (action === null || action === 'quit') return EXIT;

    const outcome = await runAction(action, session, away);
    if (outcome === BACK) return BACK;
    if (outcome === EXIT) return EXIT;
    // outcome === STAY: loop and re-display (annex may now be resolved).
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
