#!/usr/bin/env bash
# Remove only cc-suite-owned dispatch artifacts from the current project.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"

node "${SCRIPT_DIR}/sync-projects.mjs" remove \
  --scope "$PWD" \
  --project "$PWD" \
  --source "$PLUGIN_ROOT"
