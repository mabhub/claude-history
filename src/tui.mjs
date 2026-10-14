import select, { Separator } from '@inquirer/select';
import input from '@inquirer/input';
import pc from 'picocolors';
import { listSessions, findSubProjects, findParentProjects, pathExists } from './discover.mjs';
import { renderTranscript } from './transcript.mjs';
import { renameSession, setSessionColor, deleteSession } from './actions.mjs';
import { resumeWithChecks } from './resume-flow.mjs';
import { readLatestAwaySummary } from './away-summary.mjs';
import { generateTitle } from './title-gen.mjs';
import { listPrompt } from './list-prompt.mjs';
import { QUIT, promptQuittable, promptCancellable } from './prompt-keys.mjs';
import {
  pipeToViewer, hasGlow, formatSessionRow, formatDate, formatAge, formatTokens, tintTokens, tintTitle,
  cycleColor, cacheStatus, wrapText, SESSION_COLOR_NAMES, MISSING,
} from './util.mjs';
import { activeRowTheme } from './terminal-theme.mjs';
import { confirmMenu } from './confirm-menu.mjs';

/**
 * Run a list menu (@inquirer/select by default) where `q` and Escape go back,
 * or quit at the top level. See promptQuittable.
 * @param {Object} config - Config passed through to `prompt`
 * @param {Function} [prompt=select] - Inquirer prompt
 * @returns {Promise<unknown|typeof QUIT|null>} Selected value, QUIT, or null on Ctrl-C
 */
const selectQuittable = (config, prompt = select) => promptQuittable(prompt, config);

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
const LIST_HELP = [['↑↓', 'naviguer'], ['←→', 'couleur'], ['d', 'supprimer'], ['⏎', 'choisir']];
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

const AWAY_RACE_MS = 200;
const RECAP_MAX_LINES = 8;

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
 * @param {boolean} [options.nested=false] - Entered from another folder's list,
 *   so `q`/Escape go back to it instead of quitting
 * @returns {Promise<'list'|'exit'>} 'list' when `q`/Escape left this level, 'exit' to quit the whole TUI
 */
export const runInteractive = async ({ dir, cwd, displayLabel, walkedUp, nested = false }) => {
  // Value the list cursor comes back to: the session just opened, or the
  // neighbour of one just deleted. Unset (first row) on entry.
  let cursor;
  while (true) {
    const [sessions, subProjects, parentProjects, cwdMissing, theme] = await Promise.all([
      dir ? listSessions(dir) : Promise.resolve([]),
      cwd ? findSubProjects(cwd) : Promise.resolve([]),
      cwd ? findParentProjects(cwd) : Promise.resolve([]),
      cwd ? pathExists(cwd).then(ok => !ok) : Promise.resolve(true),
      activeRowTheme(),
    ]);
    if (sessions.length === 0 && subProjects.length === 0 && parentProjects.length === 0) {
      console.log(pc.yellow('Aucune conversation dans ce dossier.'));
      return BACK;
    }

    const headerLabel = displayLabel ?? cwd;
    printHeader({ label: headerLabel, walkedUp, sessionCount: sessions.length, cwdMissing, nested });

    const pageSize = Math.max(5, (process.stdout.rows ?? 20) - 6);
    const choices = buildChoices({ sessions, subProjects, parentProjects });

    const choice = await selectQuittable({
      message: 'Choisir une conversation',
      pageSize,
      choices,
      default: cursor,
      help: [...LIST_HELP, ['q', nested ? 'retour' : 'quitter']],
      theme,
    }, listPrompt);

    if (choice === QUIT) return BACK;
    if (choice === null || choice === QUIT_VALUE) return EXIT;

    if (choice.key === 'd') {
      cursor = await deleteFromList(sessions, choice.value);
      continue;
    }

    if (choice.startsWith(NAV_PREFIX)) {
      const targetDir = choice.slice(NAV_PREFIX.length);
      const target = [...parentProjects, ...subProjects].find(p => p.dir === targetDir);
      const outcome = await runInteractive({
        dir: target.dir,
        cwd: target.cwd,
        displayLabel: target.displayLabel,
        walkedUp: false,
        nested: true,
      });
      if (outcome === EXIT) return EXIT;
      cursor = choice;
      continue;
    }

    const session = sessions.find(s => s.sessionId === choice);
    const outcome = await runActionMenu(session);
    if (outcome === EXIT) return EXIT;
    cursor = outcome === DELETED ? neighbourId(sessions, choice) : choice;
    // BACK and DELETED fall through to the next loop iteration, which
    // re-fetches sessions (delete is reflected immediately).
  }
};

const printHeader = ({ label, walkedUp, sessionCount, cwdMissing, nested }) => {
  const suffix = walkedUp ? pc.dim(` (remonté depuis ${process.cwd()})`) : '';
  const missing = cwdMissing ? `  ${MISSING.badge} ${MISSING.label}` : '';
  console.log(`\nConversations dans ${pc.bold(label)}${suffix}  ${pc.dim(`(${sessionCount})`)}${missing}`);
  console.log(pc.dim(`Légende : ${LEGEND}  ·  ←→ couleur  ·  d supprimer  ·  q/Échap ${nested ? 'retour' : 'quitter'}`));
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
    choices.push({
      name: formatChoice(s),
      value: s.sessionId,
      onCycle: step => cycleSessionColor(s, step),
      keys: ['d'],
    });
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

/**
 * ← → handler for a list row: write the next `/color` and update the session
 * record in place, so an action menu opened right after sees it too.
 * @param {Object} s - Session record (mutated: `color`)
 * @param {1|-1} step - Direction
 * @returns {Promise<string>} The row's new display name
 */
const cycleSessionColor = async (s, step) => {
  const color = cycleColor(s.color, step);
  await setSessionColor({ filePath: s.filePath, sessionId: s.sessionId, color });
  s.color = color;
  return formatChoice(s);
};

// Action handlers return one of:
//   'submenu' : stay on the per-session action menu (re-display it)
//   'list'    : go back to the conversation list
//   'deleted' : the session is gone — back to the list, cursor on a neighbour
//   'exit'    : quit the whole TUI
const STAY = 'submenu';
const BACK = 'list';
const DELETED = 'deleted';
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

/**
 * Write a new title and keep the session record in sync, so the action menu's
 * header shows it on the next paint.
 * @param {Object} session - Session record (mutated: `title`, `titleSource`)
 * @param {string} title - New title
 * @returns {Promise<void>}
 */
const applyTitle = async (session, title) => {
  await renameSession({ filePath: session.filePath, sessionId: session.sessionId, title });
  session.title = title;
  session.titleSource = 'custom';
  console.log(pc.green(`✓ Renommé: ${title}`));
};

const renameAction = async session => {
  const title = await promptCancellable(input, {
    message: 'Nouveau titre',
    default: session.titleSource === 'custom' ? session.title : '',
  });
  if (title) await applyTitle(session, title);
  return STAY;
};

/**
 * Let the user pick a `/color` for the session, each name shown in its own
 * tint. Writes only when the choice differs from the current color.
 * @param {Object} session - Session record (mutated: `color`)
 * @returns {Promise<'submenu'>}
 */
const colorAction = async session => {
  const current = SESSION_COLOR_NAMES.includes(session.color) ? session.color : 'default';
  const choice = await selectQuittable({
    message: 'Couleur',
    default: current,
    choices: [
      ...SESSION_COLOR_NAMES.map(name => ({ name: tintTitle(`● ${name}`, name), value: name })),
      { name: 'Aucune (par défaut)', value: 'default' },
      { name: pc.dim('Annuler'), value: 'cancel' },
    ],
  });
  if (!choice || choice === QUIT || choice === 'cancel' || choice === current) return STAY;
  await setSessionColor({ filePath: session.filePath, sessionId: session.sessionId, color: choice });
  // Keep the record in sync, or reopening this menu compares against the old color.
  session.color = choice;
  console.log(pc.green(choice === 'default' ? '✓ Couleur retirée' : `✓ Couleur : ${tintTitle(choice, choice)}`));
  return STAY;
};

/**
 * Ask for confirmation (Escape cancels), then delete the session.
 * Shared by the action menu and the list's `d` key.
 * @param {Object} session - Session record
 * @returns {Promise<boolean>} Whether the session was deleted
 */
const confirmDelete = async session => {
  if (!(await confirmMenu(`Supprimer définitivement "${session.title}" ?`))) return false;
  const { removedDir } = await deleteSession({
    filePath: session.filePath,
    sessionId: session.sessionId,
  });
  console.log(pc.green(`✓ Supprimé${removedDir ? ' (+ dossier associé)' : ''}`));
  return true;
};

// Once deleted the session no longer exists — fall back to the refreshed list.
const deleteAction = async session => ((await confirmDelete(session)) ? DELETED : STAY);

/**
 * Row the list cursor moves to once a session is deleted: the next session,
 * else the previous one.
 * @param {Array<Object>} sessions - Sessions in list order, deleted one included
 * @param {string} sessionId - Deleted session
 * @returns {string|undefined} Session id for the cursor (undefined: first row)
 */
const neighbourId = (sessions, sessionId) => {
  const index = sessions.findIndex(s => s.sessionId === sessionId);
  return (sessions[index + 1] ?? sessions[index - 1])?.sessionId;
};

/**
 * `d` on a list row: confirm and delete, then pick the row the cursor returns
 * to — a neighbour once deleted, the same one if cancelled.
 * @param {Array<Object>} sessions - Sessions in list order
 * @param {string} sessionId - Session the key was pressed on
 * @returns {Promise<string|undefined>} Session id for the cursor
 */
const deleteFromList = async (sessions, sessionId) => {
  const session = sessions.find(s => s.sessionId === sessionId);
  return (await confirmDelete(session)) ? neighbourId(sessions, sessionId) : sessionId;
};

const resumeAction = async session => {
  const outcome = await resumeWithChecks({ sessionId: session.sessionId, filePath: session.filePath });
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
      await applyTitle(session, title);
      return STAY;
    }
    if (choice === 'edit') {
      const edited = await promptCancellable(input, { message: 'Titre', default: title });
      if (edited) await applyTitle(session, edited);
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
 * away-aware handler (generate) receives the summary explicitly.
 * @param {string} action - Selected menu value
 * @param {Object} session - Session record
 * @param {string|null} away - Cached away_summary, or null
 * @returns {Promise<'submenu'|'list'|'deleted'|'exit'>}
 */
const runAction = (action, session, away) => {
  if (action === 'view') return viewTranscript(session, { raw: false });
  if (action === 'view-raw') return viewTranscript(session, { raw: true });
  if (action === 'rename') return renameAction(session);
  if (action === 'generate') return generateTitleAction(session, away);
  if (action === 'color') return colorAction(session);
  if (action === 'delete') return deleteAction(session);
  if (action === 'resume') return resumeAction(session);
  return Promise.resolve(STAY);
};

const ACTION_HELP = [['↑↓', 'naviguer'], ['d', 'supprimer'], ['⏎', 'choisir'], ['q', 'retour']];

/**
 * Print the action menu's header: title, last activity, context size, then the
 * away_summary as a recap block, wrapped to the terminal width.
 * @param {Object} session - Session record
 * @param {string|null|typeof PENDING} away - Summary, null if none, PENDING while scanning
 * @returns {void}
 */
const printSessionHeader = (session, away) => {
  const badge = TITLE_SOURCE_BADGES[session.titleSource] ?? pc.dim('○');
  const meta = [
    pc.cyan(formatDate(session.lastActivity)),
    formatAge(session.lastActivity),
    tintTokens(formatTokens(session.contextTokens), session.contextTokens),
  ].join(pc.dim(' · '));
  console.log(`\n${badge} ${pc.dim(session.sessionId.slice(0, 8))}  ${pc.bold(tintTitle(session.title, session.color))}`);
  console.log(`  ${meta}`);
  if (away === PENDING) {
    console.log(`  ${pc.dim('⏳ Récap en cours de lecture…')}`);
  } else if (away) {
    const bar = pc.cyan('┃');
    const width = Math.max(20, (process.stdout.columns ?? 80) - 6);
    console.log(`  ${bar} ${pc.bold(pc.cyan('Récap'))}`);
    for (const line of wrapText(away, width, RECAP_MAX_LINES)) console.log(`  ${bar} ${line}`);
  }
  console.log('');
};

/**
 * Action menu choices, grouped by use: read, title and color, then the two
 * consequential ones — delete in red, resume in green while the context is
 * cached, orange once a resume pays it in full. Every entry takes `d`, the
 * shortcut for Supprimer, as in the conversation list.
 * @param {Object} session - Session record
 * @returns {Array<Object|Separator>}
 */
const actionChoices = session => {
  const cache = cacheStatus(session);
  const colorDot = SESSION_COLOR_NAMES.includes(session.color) ? tintTitle('●', session.color) : pc.dim('○');
  const choices = [
    { name: '◉ Voir le transcript', value: 'view' },
    { name: '◎ Voir le transcript (brut JSONL)', value: 'view-raw' },
    new Separator(pc.dim('— Titre et couleur —')),
    { name: tintTitle('✎ Renommer', 'blue'), value: 'rename' },
    { name: tintTitle('✦ Générer un titre (Claude)', 'blue'), value: 'generate' },
    { name: `${colorDot} Changer la couleur`, value: 'color' },
    new Separator(' '),
    { name: tintTitle('✗ Supprimer', 'red'), value: 'delete' },
    {
      name: tintTitle(`▶ Reprendre  · ${cache.warm ? '✓' : '⚠'} ${cache.label}`, cache.warm ? 'green' : 'orange'),
      value: 'resume',
    },
    new Separator(' '),
    { name: pc.dim('← Retour à la liste (q)'), value: 'back' },
    { name: pc.dim('Quitter'), value: 'quit' },
  ];
  return choices.map(c => (c instanceof Separator ? c : { ...c, keys: ['d'] }));
};

const runActionMenu = async session => {
  // Kick off the away scan; race a short delay so the menu never blocks but the
  // recap shows on the first paint when the scan is quick.
  const awayPromise = getAway(session.sessionId, session.filePath);
  let awayResolved = await Promise.race([awayPromise, delayPending(AWAY_RACE_MS)]);
  const theme = await activeRowTheme();
  // Cursor comes back on the last action run (e.g. after viewing the transcript).
  let lastAction;
  while (true) {
    // On later paints the scan has settled — reflect it from the cache.
    if (awayResolved === PENDING && awayCache.has(session.sessionId)) {
      awayResolved = awayCache.get(session.sessionId);
    }
    printSessionHeader(session, awayResolved);

    const choices = actionChoices(session);
    const choice = await selectQuittable({
      message: 'Action',
      choices,
      pageSize: choices.length,
      default: lastAction,
      help: ACTION_HELP,
      theme,
    }, listPrompt);

    if (choice === QUIT || choice === 'back') return BACK;
    if (choice === null || choice === 'quit') return EXIT;

    // `d` deletes from any row; the cursor stays on that row if it's declined.
    const action = choice.key === 'd' ? 'delete' : choice;
    lastAction = choice.key === 'd' ? choice.value : choice;
    const away = awayResolved === PENDING ? null : awayResolved;
    const outcome = await runAction(action, session, away);
    if (outcome !== STAY) return outcome;
    // STAY: loop and re-display (recap may now be resolved).
  }
};
