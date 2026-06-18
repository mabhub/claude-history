#!/usr/bin/env bash
# Smoke test for the "orphan sub-project" visual indicator.
#
# Creates a fake encoded projects directory under ~/.claude/projects/ that
# points to a sub-path of $PWD which does NOT exist on disk, then launches
# the TUI for one second so the operator can visually confirm the ⚠ badge
# and the "(dossier supprimé)" label appear.
#
# Usage: ./scripts/smoke-orphan.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GHOST_NAME="$(printf '%s/ghost-subdir-%s' "$REPO_ROOT" "$$" | sed 's/[^a-zA-Z0-9]/-/g')"
GHOST_DIR="$HOME/.claude/projects/$GHOST_NAME"
SESSION_ID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

cleanup() {
  rm -rf "$GHOST_DIR"
  echo "[smoke-orphan] cleaned $GHOST_DIR"
}
trap cleanup EXIT

mkdir -p "$GHOST_DIR"
cat > "$GHOST_DIR/$SESSION_ID.jsonl" <<'EOF'
{"type":"user","message":{"content":"hello ghost"},"timestamp":"2026-05-01T10:00:00Z"}
EOF
echo "[smoke-orphan] seeded $GHOST_DIR"
echo "[smoke-orphan] launching TUI for 1s — look for ⚠ on the sub-project line"
echo ""

cd "$REPO_ROOT"
node bin/claude-history.mjs < /dev/null &
PID=$!
sleep 1
kill "$PID" 2>/dev/null || true
wait 2>/dev/null || true
