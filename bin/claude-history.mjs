#!/usr/bin/env node
import { program } from 'commander';
import { confirm } from '@inquirer/prompts';
import pc from 'picocolors';
import { findProjectDir, listSessions } from '../src/discover.mjs';
import { renderTranscript } from '../src/transcript.mjs';
import { renameSession, deleteSession, resumeSession } from '../src/actions.mjs';
import { runInteractive } from '../src/tui.mjs';
import { pipeToPager, formatDate, resolveId } from '../src/util.mjs';

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

const cmdLs = async () => {
  const { dir, cwd, walkedUp } = await resolveProject();
  const sessions = await listSessions(dir);
  if (walkedUp) {
    console.log(pc.dim(`(remonté depuis ${process.cwd()} → ${cwd})`));
  }
  console.log(pc.bold(`Conversations dans ${cwd} (${sessions.length}) :\n`));
  for (const s of sessions) {
    const id = pc.dim(s.sessionId.slice(0, 8));
    const date = pc.cyan(formatDate(s.mtime));
    const title = s.title === '(sans titre)' ? pc.dim(s.title) : s.title;
    console.log(`  ${id}  ${date}  ${title}`);
  }
};

const cmdShow = async (idOrPrefix, opts) => {
  const { dir } = await resolveProject();
  const sessions = await listSessions(dir);
  const sessionId = resolveId(idOrPrefix, sessions);
  const session = sessions.find(s => s.sessionId === sessionId);
  const text = await renderTranscript({
    filePath: session.filePath,
    raw: Boolean(opts.raw),
    verbose: Boolean(opts.verbose),
  });
  if (opts.noPager) {
    process.stdout.write(text);
  } else {
    await pipeToPager(text);
  }
};

const cmdRename = async (idOrPrefix, title) => {
  const { dir } = await resolveProject();
  const sessions = await listSessions(dir);
  const sessionId = resolveId(idOrPrefix, sessions);
  const session = sessions.find(s => s.sessionId === sessionId);
  await renameSession({
    filePath: session.filePath,
    sessionId,
    title,
  });
  console.log(pc.green(`✓ ${sessionId.slice(0, 8)} renommé en "${title}"`));
};

const cmdRm = async (idOrPrefix, opts) => {
  const { dir } = await resolveProject();
  const sessions = await listSessions(dir);
  const sessionId = resolveId(idOrPrefix, sessions);
  const session = sessions.find(s => s.sessionId === sessionId);
  if (!opts.yes) {
    const ok = await confirm({
      message: `Supprimer définitivement "${session.title}" (${sessionId.slice(0, 8)}) ?`,
      default: false,
    }).catch(() => false);
    if (!ok) {
      console.log(pc.dim('Annulé.'));
      return;
    }
  }
  const { removedDir } = await deleteSession({
    filePath: session.filePath,
    sessionId,
  });
  console.log(pc.green(`✓ Supprimé${removedDir ? ' (+ dossier associé)' : ''}`));
};

const cmdResume = async idOrPrefix => {
  const { dir } = await resolveProject();
  const sessions = await listSessions(dir);
  const sessionId = resolveId(idOrPrefix, sessions);
  await resumeSession(sessionId);
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
  .action(async () => {
    const project = await resolveProject();
    await runInteractive(project);
  });

program.parseAsync(process.argv).catch(err => {
  console.error(pc.red(err.message ?? String(err)));
  process.exit(1);
});
