# claude-history

Browse, rename and manage Claude Code conversation transcripts attached to the
current directory. Lighter alternative to `claude --resume` when you just want
to inspect or clean up past sessions.

## Install

Run it directly without installing:

```bash
npx @mab/claude-history
```

Or install globally for the `claude-history` / `clh` binaries:

```bash
npm install -g @mab/claude-history
# or from a local clone:
git clone https://github.com/mabhub/claude-history.git
cd claude-history
npm install && npm link
```

Provides two binaries: `claude-history` and the shorter `clh`.

The unscoped `claude-history` package on npm is an unrelated tool.

## Usage

```bash
# Interactive TUI (arrow keys)
clh

# List conversations for the cwd (walks up to parent if empty)
clh ls                   # id · date · relative age · context tokens · title

# Show a transcript (readable, piped to $PAGER)
clh show <id>            # 8-char prefix or full UUID accepted
clh show <id> --raw      # pretty-printed JSON
clh show <id> --no-pager # stdout
clh show <id> --verbose  # include system/hook entries

# Rename (writes a custom-title entry, fully compatible with /rename)
clh rename <id> "my title"

# Color (writes an agent-color entry, like /color; "default" removes it)
clh color <id> pink

# Delete (interactive confirm; -y to skip)
clh rm <id>
clh rm <id> -y

# Resume
clh resume <id>          # exec claude --resume <id>, in the session's own cwd
```

`resume` runs `claude --resume` in the directory the conversation was recorded
in (read from the transcript), not wherever you launched `clh` — so resuming a
sub-folder or another project's session still finds it.

An id that matches nothing in the current project is looked up across every
project: `show`, `rename` and `color` proceed with a warning, `rm` and `resume`
ask for confirmation first.

When the conversation has left Claude's prompt cache, `resume` says since when
and how many tokens the resume will reload at full price, and asks to confirm.

If that original directory no longer exists, `clh` offers to recreate it
(`mkdir -p`) so Claude can locate the session — Claude resolves a session id
against the current directory, so it must run somewhere that maps back to the
conversation's storage folder. Without a terminal (piped/scripted), `resume`
prints guidance and exits non-zero rather than resuming in the wrong place.

## Interactive TUI

`clh` with no argument opens the conversation list. Each row shows the date,
age, context size and title, tinted with the session's `/color`; a bullet tells
where the title comes from (green: `/rename`, yellow: auto-generated, dim: the
first prompt).

| Key        | Conversation list                   | Action menu         |
|------------|-------------------------------------|---------------------|
| `↑` `↓`    | move                                | move                |
| `←` `→`    | cycle the highlighted session color |                     |
| `d`        | delete the highlighted session      | delete this session |
| `⏎`        | open the action menu                | run the action      |
| `q` / Esc  | back to the parent folder, or quit  | back to the list    |

Confirmations are a Oui / Non menu with the cursor on Non: `q`, Escape and
Ctrl-C answer no.

The action menu opens on a header with the date, context size and, when the
session has one, its `away_summary` as a recap. Its entries: view the transcript
(readable or raw JSONL), rename, generate a title, change the color, delete,
and resume. The resume entry is green while the context is still cached and
orange once a resume would reload it in full.

From that menu you can also **generate a title with Claude**:
`clh` runs `claude -p` on the session's `away_summary` (or its first prompt when
none exists) and proposes a title you can accept, edit, or regenerate. The call
runs isolated from any project context (neutral cwd, no settings, task pinned in
a system prompt) so it returns a bare title. This is the only action that
invokes Claude — browsing and listing stay fully local. When a session has an
`away_summary`, it's also shown as a reminder while you rename.

## Skill usage analytics

`clh skills` mines **every** transcript under `~/.claude/projects` (all
projects, including subagent transcripts) to report how skills are actually
used. Unlike the other subcommands it is global, not cwd-scoped.

```bash
# Per-skill summary: counts, sessions, projects, channel + success breakdown
clh skills

# Evolution over time — the matrix you usually want
clh skills --timeseries --bucket month            # long format (period, skill, count)
clh skills --timeseries --bucket day --pivot      # wide matrix: period × skill
clh skills --timeseries --skill brainstorming     # focus on one skill

# Success rate per skill + the invalid names that failed ("Unknown skill")
clh skills --success

# Which skills get chained in the same session (your real workflows)
clh skills --cooccurrence

# Skill × project matrix
clh skills --by-project

# Raw normalized dataset — one row per invocation, maximum granularity
clh skills --events --format csv > skills.csv
```

Cross-cutting flags: `--format table|csv|json`, `--bucket day|week|month`,
`--skill <substring|regex>`, `--channel tool|slash|all`, `--since/--until <iso>`,
`--root <path>`, `--out <file>`.

### Two activation channels, deduplicated

A skill can be activated two ways, logged differently in the transcripts:

- **tool** — the assistant called the `Skill` tool (a `tool_use` block, paired
  with its `tool_result` so success vs. `Unknown skill` failures are known).
- **slash** — the user typed `/<skill>`; Claude Code expands it inline into a
  user message (`Base directory for this skill: …/skills/<name>`) with **no**
  `Skill` tool_use. A tool-only count misses these entirely.

When a skill is run via the tool, Claude Code emits **both** a `tool_use` and a
slash-expansion message a moment apart — counting both double-counts the
invocation. `clh skills` collapses each such pair (same canonical skill,
session and agent, within 5 s), keeping the richer tool event and tagging it
`bothChannels`. Genuine user-typed `/skill` activations (no tool twin) are kept
as real `slash` invocations. Pass `--no-dedupe` to see the raw, doubled log.

The dual-logged activations stay visible: the summary shows a `both` column and
`--events` a `bothChannels` field, so you can tell tool-driven runs (logged on
both channels) from genuine user-typed `/skill` invocations.

Plugin skills are logged with their namespace by the tool channel
(`superpowers:brainstorming`) but as the bare directory name by the slash
channel (`brainstorming`). Events carry the canonical `skill` (namespace
stripped, used for grouping), the raw `skillRaw`, and the `namespace`
(`superpowers`, `builtin`, …) so nothing is lost.

## How it works

Claude Code stores each conversation as `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
where `<encoded-cwd>` is the cwd with every non-alphanumeric character replaced
by `-` (so `/home/you/.config/foo` becomes `-home-you--config-foo`). Listing
reads only the head of each file (first prompt) and its last 64 KB (latest
title, color, activity and context size), so large transcripts stay cheap.
Renaming and recoloring append the same JSONL entries `/rename` and `/color`
write inside Claude Code (e.g.
`{"type":"custom-title","customTitle":"...","sessionId":"..."}`); nothing is
ever rewritten.

If the current directory has no transcripts, `clh` walks up to parents until it
finds one — useful when you ran Claude from a project root but are currently in
a sub-directory.

The interactive TUI also lists **parent and sub-projects**: ancestor and
descendant directories that have their own transcripts. They appear at the top
of the list; selecting one re-enters the TUI for that directory, and `q` comes
back.

## Viewers

- If [`glow`](https://github.com/charmbracelet/glow) is installed, transcripts
  are rendered as Markdown and piped to `glow -p`.
- Otherwise transcripts are styled with ANSI escapes and piped to `$PAGER`
  (or `less -R`).
- `clh show <id> --raw` always uses the regular pager (raw JSON, not markdown).

## Terminal theme

The TUI paints the highlighted row of every menu on a tinted background, blue-grey
on dark terminals and pale blue on light ones. It asks the terminal for its
background color (OSC 11), falls back to GNOME's light/dark preference, then
to light. Set `CLH_THEME=dark` or `CLH_THEME=light` to force it.

## Tests

```bash
npm test
```

Uses Node's built-in test runner — no extra dev dependency.
