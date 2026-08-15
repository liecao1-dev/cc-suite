#!/usr/bin/env bash
# Install the literal /codex project command from the canonical plugin command.
# Refuses to overwrite a user-owned .claude/commands/codex.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
SOURCE="${PLUGIN_ROOT}/commands/codex.md"
TARGET=".claude/commands/codex.md"

if [ ! -f "$SOURCE" ]; then
  printf '! canonical dispatcher missing: %s\n' "$SOURCE" >&2
  exit 1
fi

mkdir -p .claude/commands

python3 - "$SOURCE" "$TARGET" "$PLUGIN_ROOT" <<'PY'
from __future__ import annotations

import hashlib
import os
import re
import sys
import tempfile
from pathlib import Path

source_path = Path(sys.argv[1])
target_path = Path(sys.argv[2])
plugin_root = sys.argv[3]
marker_re = re.compile(r"^<!-- cc-suite-dispatcher: codex sha256=([0-9a-f]{64}) -->$", re.M)


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def without_marker(text: str) -> tuple[str, str | None]:
    match = marker_re.search(text)
    if not match:
        return text, None
    start, end = match.span()
    if end < len(text) and text[end] == "\n":
        end += 1
    return text[:start] + text[end:], match.group(1)


def is_owned(text: str) -> bool:
    body, recorded = without_marker(text)
    return recorded is not None and digest(body) == recorded


def add_marker(body: str) -> str:
    marker = f"<!-- cc-suite-dispatcher: codex sha256={digest(body)} -->\n"
    if body.startswith("---\n"):
        close = body.find("\n---\n", 4)
        if close != -1:
            insert = close + len("\n---\n")
            return body[:insert] + marker + body[insert:]
    return marker + body


canonical = source_path.read_text(encoding="utf-8")
body = canonical.replace("${CLAUDE_PLUGIN_ROOT}", plugin_root)
generated = add_marker(body)

if target_path.is_symlink():
    print(f"! {target_path} is a symlink not owned by cc-suite — left alone", file=sys.stderr)
    raise SystemExit(0)

if target_path.exists():
    existing = target_path.read_text(encoding="utf-8")
    if not is_owned(existing):
        print(f"! {target_path} already exists and is user-owned — left alone", file=sys.stderr)
        raise SystemExit(0)
    if existing == generated:
        print(f"· {target_path} already exposes /codex")
        raise SystemExit(0)

target_path.parent.mkdir(parents=True, exist_ok=True)
fd, tmp_name = tempfile.mkstemp(prefix=".codex-dispatcher-", dir=target_path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(generated)
    os.chmod(tmp_name, 0o644)
    os.replace(tmp_name, target_path)
except BaseException:
    try:
        os.unlink(tmp_name)
    except FileNotFoundError:
        pass
    raise

print(f"✓ {target_path} installed — invoke with /codex <task>")
PY

# Keep the machine-generated shim local without hiding a pre-existing user file
# through a shared .gitignore rule. Only add the exact path after we verified the
# installed file is cc-suite-owned.
if [ -f "$TARGET" ] && python3 - "$TARGET" <<'PY'
import hashlib
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8")
match = re.search(r"^<!-- cc-suite-dispatcher: codex sha256=([0-9a-f]{64}) -->$", text, re.M)
if not match:
    raise SystemExit(1)
start, end = match.span()
if end < len(text) and text[end] == "\n":
    end += 1
body = text[:start] + text[end:]
raise SystemExit(0 if hashlib.sha256(body.encode("utf-8")).hexdigest() == match.group(1) else 1)
PY
then
  git_dir="$(git rev-parse --git-dir 2>/dev/null || true)"
  if [ -n "$git_dir" ] && [ -d "$git_dir/info" ]; then
    exclude_file="${git_dir}/info/exclude"
    if ! grep -qxF '.claude/commands/codex.md' "$exclude_file" 2>/dev/null; then
      printf '%s\n' '.claude/commands/codex.md' >> "$exclude_file"
    fi
  fi
fi
