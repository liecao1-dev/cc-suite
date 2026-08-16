#!/usr/bin/env bash
# Install the exact /codex and $claude discovery entries plus local TTY hooks.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"

args=(
  sync
  --scope "$PWD"
  --project "$PWD"
  --source "$PLUGIN_ROOT"
)
if [ -n "${CC_SUITE_CODEX_CATALOG_FILE:-}" ]; then
  args+=(--catalog-file "$CC_SUITE_CODEX_CATALOG_FILE")
fi

node "${SCRIPT_DIR}/sync-projects.mjs" "${args[@]}"
