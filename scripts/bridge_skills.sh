#!/usr/bin/env bash
# cc-suite: expose skills to Codex via .agents/skills (idempotent).
#
# The explicit $claude dispatcher is linked directly at
# .agents/skills/claude/. Codex scans immediate skill directories at that real
# path; it does not discover the old .agents/skills → ../.claude/skills root
# symlink plus cc-suite/claude nesting.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
PLUGIN_SKILLS="${PLUGIN_ROOT}/skills/cc-suite"
CLAUDE_SKILL="${PLUGIN_SKILLS}/claude"

ok()   { printf '✓ %s\n' "$*"; }
skip() { printf '· %s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }

# The plugin skills tree must exist before linking to it — a missing source
# would otherwise produce a broken symlink and a misleading success message.
if [ ! -f "$CLAUDE_SKILL/SKILL.md" ]; then
  warn "Claude dispatcher skill missing: ${CLAUDE_SKILL}/SKILL.md"
  exit 1
fi

# ── Step 1: remove only obsolete cc-suite-owned links ───────────────────────

mkdir -p .claude/skills

# Remove only the obsolete cc-suite-owned bundle link. A real directory or a
# symlink to an unrelated location remains user-owned and is never touched.
if [ -L .claude/skills/cc-suite ]; then
  legacy_target="$(readlink .claude/skills/cc-suite)"
  case "$legacy_target" in
    */skills/cc-suite)
      rm .claude/skills/cc-suite
      ok "removed obsolete nested .claude/skills/cc-suite link"
      ;;
    *)
      warn ".claude/skills/cc-suite points to ${legacy_target} — unrelated symlink left alone"
      ;;
  esac
elif [ -e .claude/skills/cc-suite ]; then
  warn ".claude/skills/cc-suite exists as a real path — leaving alone to avoid data loss"
fi

# A short-lived development build also linked the dispatcher into
# .claude/skills/claude. Claude does not need this Codex-only skill, so migrate
# that proven cc-suite-owned link away while preserving every other path.
if [ -L .claude/skills/claude ]; then
  interim_target="$(readlink .claude/skills/claude)"
  case "$interim_target" in
    */skills/cc-suite/claude)
      rm .claude/skills/claude
      ok "removed obsolete .claude/skills/claude link"
      ;;
    *)
      warn ".claude/skills/claude points to ${interim_target} — user symlink left alone"
      ;;
  esac
fi

# ── Step 2: ensure the Codex scan root is a real directory ──────────────────

mkdir -p .agents

if [ -L .agents/skills ]; then
  root_target="$(readlink .agents/skills)"
  if [ "$root_target" = "../.claude/skills" ]; then
    rm .agents/skills
    mkdir -p .agents/skills
    ok "migrated .agents/skills from a root symlink to a real scan directory"
  else
    warn ".agents/skills points to ${root_target} — user symlink left alone"
    exit 1
  fi
elif [ -d .agents/skills ]; then
  skip ".agents/skills is already a real scan directory"
elif [ -e .agents/skills ]; then
  warn ".agents/skills exists but is not a directory — leaving it alone"
  exit 1
else
  mkdir -p .agents/skills
  ok ".agents/skills scan directory created"
fi

# ── Step 3: expose $claude as an immediate skill directory ─────────────────

target=".agents/skills/claude"
if [ -L "$target" ]; then
  existing="$(readlink "$target")"
  if [ "$existing" = "$CLAUDE_SKILL" ]; then
    skip "${target} already symlinked → ${CLAUDE_SKILL}"
  else
    case "$existing" in
      */skills/cc-suite/claude|../../.claude/skills/claude)
        # Repoint a link made by an older plugin cache atomically. rename(2)
        # replaces the link itself without following it.
        python3 - "$CLAUDE_SKILL" "$target" <<'PY'
import os
import sys

source, target = sys.argv[1:]
tmp = f"{target}.cc-suite-repoint-{os.getpid()}"
os.symlink(source, tmp)
try:
    os.replace(tmp, target)
except BaseException:
    os.unlink(tmp)
    raise
PY
        ok "${target} repointed → ${CLAUDE_SKILL}"
        ;;
      *)
        warn "${target} points to ${existing} — user symlink left alone"
        exit 1
        ;;
    esac
  fi
elif [ -e "$target" ]; then
  warn "${target} exists as a user-owned path — leaving it alone"
  exit 1
else
  ln -s "$CLAUDE_SKILL" "$target"
  ok "${target} → ${CLAUDE_SKILL}"
fi

# ── Step 4: ensure .gitignore covers the managed link ───────────────────────
# Hand off to the shared helper (also used by init.sh). CC_SUITE_RESPECT_MODE
# preserves a PRIVATE block if the project chose that mode; new blocks are
# created in the default public mode.
CC_SUITE_RESPECT_MODE=1 bash "$SCRIPT_DIR/ensure_gitignore.sh"
