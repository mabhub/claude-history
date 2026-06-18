# claude-history

Browse, rename and manage Claude Code conversation transcripts attached to the
current directory. Lighter alternative to `claude --resume` when you just want
to inspect or clean up past sessions.

## Install

Run it directly without installing:

```bash
npx github:mabhub/claude-history
```

Or install globally for the `claude-history` / `clh` binaries:

```bash
npm install -g claude-history
# or from a local clone:
git clone https://github.com/mabhub/claude-history.git
cd claude-history
npm install && npm link
```

Provides two binaries: `claude-history` and the shorter `clh`.

## Usage

```bash
# Interactive TUI (arrow keys)
clh

# List conversations for the cwd (walks up to parent if empty)
clh ls

# Show a transcript (readable, piped to $PAGER)
clh show <id>            # 8-char prefix or full UUID accepted
clh show <id> --raw      # pretty-printed JSON
clh show <id> --no-pager # stdout
clh show <id> --verbose  # include system/hook entries

# Rename (writes a custom-title entry, fully compatible with /rename)
clh rename <id> "my title"

# Delete (interactive confirm; -y to skip)
clh rm <id>
clh rm <id> -y

# Resume
clh resume <id>          # exec claude --resume <id>
```

## How it works

Claude Code stores each conversation as `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
where `<encoded-cwd>` is the cwd with `/` replaced by `-`. `clh` reads those files,
streams headers to extract titles, and supports the same `custom-title` mechanism
that `/rename` uses inside Claude Code (an appended JSONL entry —
`{"type":"custom-title","customTitle":"...","sessionId":"..."}`).

If the current directory has no transcripts, `clh` walks up to parents until it
finds one — useful when you ran Claude from a project root but are currently in
a sub-directory.
