#!/usr/bin/env node
import path from 'node:path';
import { program } from 'commander';
import confirm from '@inquirer/confirm';
import pc from 'picocolors';
import { findProjectDir, listSessions, listSessionIds, findSubProjects, findSessionGlobally, pathExists } from '../src/discover.mjs';
import { renderTranscript } from '../src/transcript.mjs';
import { renameSession, deleteSession, resumeSession } from '../src/actions.mjs';
import { runInteractive } from '../src/tui.mjs';
import { cmdSkills } from '../src/skills-command.mjs';
import { pipeToViewer, hasGlow, formatDate, resolveId, MISSING } from '../src/util.mjs';

/**
 * Resolve the project directory for the current cwd. Walks up to parents
 * if the immediate directory has no transcripts. Exits with a clear message
 * if nothing is found anywhere.
 * @returns {Promise<{dir: string, cwd: string, walkedUp: boolean}>}
 */
const resolveProject = async () => {
  const found = await findProjectDir(process.cwd());
  if (!found.dir) {
    console.error(
      pc.red(
        `Aucune conversation Claude Code trouvée pour ${process.cwd()} ni ses parents.`,
      ),
    );
    process.exit(1);
  }
  return found;
};

/**
 * Resolve an id prefix to a full session, using only readdir (no JSONL parse).
 * Looks in the current project first; if the id matches nothing locally, falls
 * back to a filesystem-wide search under ~/.claude/projects. A local ambiguity
 * is reported as-is (we never paper over it with a global match). When the
 * session is found in another project, `foundElsewhere` is set so callers can
 * warn (read-only ops) or confirm (destructive ops) before proceeding.
 * @param {string} idOrPrefix - Short prefix or full UUID
 * @returns {Promise<{sessionId: string, filePath: string, dir: string, foundElsewhere: boolean, encodedDir: string|null}>}
 */
const resolveSession = async idOrPrefix => {
  const { dir } = await resolveProject();
  const ids = await listSessionIds(dir);
  const localMatches = ids.filter(id => id.startsWith(idOrPrefix));

  // Found locally (one match, or a local ambiguity we want to surface): delegate
  // to resolveId for the canonical messages and short-circuit the global search.
  if (localMatches.length >= 1) {
    const sessionId = resolveId(idOrPrefix, ids);
    return { sessionId, filePath: path.join(dir, `${sessionId}.jsonl`), dir, foundElsewhere: false, encodedDir: null };
  }

  // Not in the current project — search every project directory.
  const global = await findSessionGlobally(idOrPrefix);
  if (global.length === 0) {
    // Reuse resolveId solely for its "no match" / "too short" wording.
    resolveId(idOrPrefix, ids);
  }
  if (global.length > 1) {
    const list = global
      .map(m => `${m.sessionId.slice(0, 8)} (${m.encodedDir})`)
      .join(', ');
    throw new Error(`Ambiguous id "${idOrPrefix}" across projects (matches: ${list}). Use a longer prefix.`);
  }
  const { sessionId, dir: foundDir, encodedDir } = global[0];
  return {
    sessionId,
    filePath: path.join(foundDir, `${sessionId}.jsonl`),
    dir: foundDir,
    foundElsewhere: true,
    encodedDir,
  };
};

/**
 * Emit a stderr warning that an id was resolved outside the current project.
 * Used by read-only commands (show, rename) that proceed without confirmation.
 * @param {{encodedDir: string}} session - Resolved session carrying its project dir name
 * @returns {void}
 */
const warnFoundElsewhere = session => {
  console.error(pc.yellow(
    `⚠ Aucune conversation avec cet id dans le projet courant — trouvée dans ${session.encodedDir}.`,
  ));
};

/**
 * Ask the user to confirm acting on a session that lives in another project.
 * Used by destructive commands (rm, resume). Returns true to proceed.
 * @param {{sessionId: string, encodedDir: string}} session - Resolved session
 * @param {string} verb - Action label shown in the prompt (e.g. "Reprendre")
 * @returns {Promise<boolean>}
 */
const confirmFoundElsewhere = async (session, verb) => {
  console.error(pc.yellow(
    `⚠ Aucune conversation avec cet id dans le projet courant — trouvée dans ${session.encodedDir}.`,
  ));
  return confirm({
    message: `${verb} ${session.sessionId.slice(0, 8)} hors du projet courant ?`,
    default: false,
  }).catch(() => false);
};

const cmdLs = async () => {
  const { dir, cwd, walkedUp } = await resolveProject();
  const [sessions, cwdMissing] = await Promise.all([
    listSessions(dir),
    pathExists(cwd).then(ok => !ok),
  ]);
  if (walkedUp) {
    console.log(pc.dim(`(remonté depuis ${process.cwd()} → ${cwd})`));
  }
  const missingSuffix = cwdMissing ? `  ${MISSING.badge} ${MISSING.label}` : '';
  console.log(pc.bold(`Conversations dans ${cwd} (${sessions.length}) :${missingSuffix}\n`));
  for (const s of sessions) {
    const id = pc.dim(s.sessionId.slice(0, 8));
    const date = pc.cyan(formatDate(s.mtime));
    const title = s.title === '(sans titre)' ? pc.dim(s.title) : s.title;
    console.log(`  ${id}  ${date}  ${title}`);
  }
};

const cmdShow = async (idOrPrefix, opts) => {
  const session = await resolveSession(idOrPrefix);
  if (session.foundElsewhere) warnFoundElsewhere(session);
  const { filePath } = session;
  const useMarkdown = !opts.raw && opts.pager !== false && hasGlow();
  const text = await renderTranscript({
    filePath,
    raw: Boolean(opts.raw),
    verbose: Boolean(opts.verbose),
    style: useMarkdown ? 'markdown' : 'ansi',
  });
  if (opts.pager === false) {
    process.stdout.write(text);
  } else {
    await pipeToViewer({ text, markdown: useMarkdown });
  }
};

const cmdRename = async (idOrPrefix, title) => {
  const session = await resolveSession(idOrPrefix);
  if (session.foundElsewhere) warnFoundElsewhere(session);
  const { sessionId, filePath } = session;
  await renameSession({ filePath, sessionId, title });
  console.log(pc.green(`✓ ${sessionId.slice(0, 8)} renommé en "${title}"`));
};

const cmdRm = async (idOrPrefix, opts) => {
  const session = await resolveSession(idOrPrefix);
  const { sessionId, filePath } = session;
  if (session.foundElsewhere && !(await confirmFoundElsewhere(session, 'Supprimer'))) {
    console.log(pc.dim('Annulé.'));
    return;
  }
  if (!opts.yes) {
    const ok = await confirm({
      message: `Supprimer définitivement ${sessionId.slice(0, 8)} ?`,
      default: false,
    }).catch(() => false);
    if (!ok) {
      console.log(pc.dim('Annulé.'));
      return;
    }
  }
  const { removedDir } = await deleteSession({ filePath, sessionId });
  console.log(pc.green(`✓ Supprimé${removedDir ? ' (+ dossier associé)' : ''}`));
};

const cmdResume = async idOrPrefix => {
  const session = await resolveSession(idOrPrefix);
  if (session.foundElsewhere && !(await confirmFoundElsewhere(session, 'Reprendre'))) {
    console.log(pc.dim('Annulé.'));
    return;
  }
  await resumeSession(session.sessionId);
};

program
  .name('claude-history')
  .description('Browse, rename and manage Claude Code conversation transcripts for the current directory.')
  .version('0.1.0');

program
  .command('ls')
  .description('List conversations attached to the current directory.')
  .action(cmdLs);

program
  .command('show <id>')
  .description('Display a conversation transcript (lisible par défaut, --raw pour JSONL brut).')
  .option('--raw', 'Dump pretty-printed JSON instead of formatted text')
  .option('--verbose', 'Include system/hook entries')
  .option('--no-pager', 'Print to stdout instead of piping to $PAGER')
  .action(cmdShow);

program
  .command('rename <id> <title>')
  .description('Set a custom title (équivalent /rename de Claude Code).')
  .action(cmdRename);

program
  .command('rm <id>')
  .description('Delete a conversation (file + companion dir).')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(cmdRm);

program
  .command('resume <id>')
  .description('Run `claude --resume <sessionId>`.')
  .action(cmdResume);

program
  .command('skills')
  .description('Statistiques d\'utilisation des skills sur tout l\'historique Claude Code.')
  .option('--timeseries', 'Évolution dans le temps (matrice skill × période)')
  .option('--success', 'Taux de succès par skill + invocations invalides (Unknown skill)')
  .option('--cooccurrence', 'Paires de skills partageant une même session')
  .option('--by-project', 'Matrice skill × projet')
  .option('--events', 'Dump du dataset brut normalisé (granularité maximale)')
  .option('--bucket <unit>', 'Granularité temporelle : day|week|month', 'month')
  .option('--pivot', 'Pour --timeseries : matrice large (période × skill) au lieu du format long')
  .option('--channel <chan>', 'Filtrer le canal : tool|slash|all', 'all')
  .option('--no-dedupe', 'Ne pas fusionner le double-log tool+slash d\'une même activation')
  .option('--skill <pattern>', 'Filtrer les skills (sous-chaîne ou regex, insensible à la casse)')
  .option('--since <iso>', 'Borne basse incluse sur la date (ex. 2026-05-01)')
  .option('--until <iso>', 'Borne haute incluse sur la date')
  .option('--format <fmt>', 'Format de sortie : table|csv|json', 'table')
  .option('--root <path>', 'Racine des transcripts (défaut ~/.claude/projects)')
  .option('--out <file>', 'Écrire dans un fichier au lieu de stdout')
  .action(cmdSkills);

program.action(async () => {
  const found = await findProjectDir(process.cwd());
  if (found.dir) {
    await runInteractive(found);
    return;
  }
  // No direct project, but maybe sub-projects under the cwd.
  const subs = await findSubProjects(process.cwd());
  if (subs.length === 0) {
    console.error(pc.red(
      `Aucune conversation Claude Code trouvée pour ${process.cwd()} ni ses parents.`,
    ));
    process.exit(1);
  }
  await runInteractive({ dir: null, cwd: process.cwd(), walkedUp: false });
});

program.parseAsync(process.argv).catch(err => {
  console.error(pc.red(err.message ?? String(err)));
  process.exit(1);
});
