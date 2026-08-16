---
name: cc-suite
description: "Project instructions for the simple Claude Code ↔ Codex dispatcher."
---

# Project Instructions

> cc-suite simple dispatch

## Product contract

- Claude → Codex starts by typing `/codex`, choosing a `/codex-*`
  configuration candidate in the composer, appending the plain-language task,
  and sending once.
- Codex → Claude starts by typing `$claude`, choosing a `$claude-*`
  configuration candidate in the composer, appending the plain-language task,
  and sending once.
- Every dispatch requires an explicit pre-send configuration choice. Keep the
  candidates numbered as recent configuration, default configuration, then
  remaining models so the composer order is stable.
- Recent means the last selected `model + effort + access` tuple, never the
  newest released model. On a project's first use, the recent entry visibly
  resolves to the default tuple.
- Routing is non-sticky. Every new task or follow-up must repeat the target
  prefix. Configuration answers belong to the pending dispatch.
- Never silently fall back to the host model when a target is unavailable.
- Do not reintroduce task-taxonomy commands such as implement/audit/plan/debug.

## Engineering rules

- Bump `.claude-plugin/plugin.json` and `package.json` together for every release.
- `main` always equals the newest release tag. Do not push an untagged commit to
  `main`; feature work stays on a branch until release is intentional.
- New public Claude commands live in `commands/`. New Codex skills live in
  `skills/cc-suite/<name>/SKILL.md` and must follow `skill-creator` validation.
- Delegating skills must set `policy.allow_implicit_invocation: false`.
- All scripts under `scripts/` are idempotent and must preserve user-owned files.
- Write project instructions only to `AGENTS.md`; never edit `CLAUDE.md` directly.

## Core architecture

- `scripts/sync-projects.mjs` discovers actual project roots inside an explicit
  scope and installs or removes only project-local dispatch artifacts.
- `scripts/lib/project-dispatch.mjs` generates the ordered Claude-side
  `/codex-*` choices, owns their hashes, and preserves collisions.
- `scripts/install_dispatchers.sh` is the single-project compatibility wrapper
  around the scoped synchronizer. There is intentionally no exact `/codex`
  command because it would submit before configuration selection.
- `skills/cc-suite/claude-*/` contains the ordered, explicit Codex-side
  `$claude` configuration candidates.
- `scripts/dispatch-config.mjs` discovers capabilities, orders chooser profiles,
  validates choices, and stores per-project MRU state.
- `scripts/lib/dispatch-config.mjs` contains the pure ordering/validation logic.
- `scripts/codex-runner.mjs` provides the deadline-bounded Claude → Codex lane.
- `scripts/claude-runner.mjs` provides the symmetric deadline-bounded
  Codex → Claude lane. Normal dispatch does not require project MCP config.
- `scripts/lib/delegation-boundary.mjs` prevents delegated agents from handing a
  task back to its author.

Legacy backend and bridge code may remain for compatibility, but it must stay
hidden from the normal command surface until it adopts the same model-named,
per-call selection contract.

## Tests

```bash
npm test
bash tests/integration.sh
```

Validate every `$claude` configuration skill separately:

```bash
for skill in skills/cc-suite/claude-*; do
  python3 <skill-creator-dir>/scripts/quick_validate.py "$skill"
done
```

After setup changes, initialize a temporary project twice and confirm:

- `/codex-*` generated skills remain byte-identical on the second run;
- `$claude` is visible through `.agents/skills`;
- project state resolves to the project marker while execution keeps the
  user's active subdirectory;
- a user-owned or edited `.claude/skills/codex-*` or legacy exact `/codex`
  command is never overwritten.

## Release discipline

This branch is a breaking 3.x redesign because old public task commands and
task-specific Claude skills were removed. Do not tag or push a release unless
the user explicitly authorizes publishing.
