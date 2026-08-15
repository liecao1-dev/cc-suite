#!/usr/bin/env bash
# Remove only an unchanged cc-suite-generated /codex project command.

set -euo pipefail

python3 - <<'PY'
import hashlib
import re
from pathlib import Path

target = Path(".claude/commands/codex.md")
marker = re.compile(r"^<!-- cc-suite-dispatcher: codex sha256=([0-9a-f]{64}) -->$", re.M)

if not target.exists() or target.is_symlink():
    print("· .claude/commands/codex.md is missing or not cc-suite-owned")
    raise SystemExit(0)

text = target.read_text(encoding="utf-8")
match = marker.search(text)
if not match:
    print("· .claude/commands/codex.md is user-owned — left alone")
    raise SystemExit(0)

start, end = match.span()
if end < len(text) and text[end] == "\n":
    end += 1
body = text[:start] + text[end:]
if hashlib.sha256(body.encode("utf-8")).hexdigest() != match.group(1):
    print("· .claude/commands/codex.md was edited after generation — left alone")
    raise SystemExit(0)

target.unlink()
print("✓ removed .claude/commands/codex.md (cc-suite generated)")
try:
    target.parent.rmdir()
except OSError:
    pass
PY

git_dir="$(git rev-parse --git-dir 2>/dev/null || true)"
if [ -n "$git_dir" ] && [ -f "${git_dir}/info/exclude" ]; then
  python3 - "${git_dir}/info/exclude" <<'PY'
from pathlib import Path
import sys

p = Path(sys.argv[1])
lines = p.read_text(encoding="utf-8").splitlines()
filtered = [line for line in lines if line != ".claude/commands/codex.md"]
if filtered != lines:
    p.write_text("\n".join(filtered) + ("\n" if filtered else ""), encoding="utf-8")
PY
fi
