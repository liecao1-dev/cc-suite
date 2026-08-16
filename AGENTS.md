---
name: cc-suite
description: "Project instructions for the simple Claude Code ↔ Codex dispatcher."
---

# Project Instructions

> cc-suite simple dispatch

## Product contract

- Claude → Codex starts with an exact `/codex`; Codex → Claude starts with an
  exact `$claude`. The trigger is a control message, never a task.
- Before either host model receives the trigger, a project-local hook opens a
  keyboard picker on `/dev/tty`, saves the selection, and blocks the trigger.
- The model menu is compact: recent configuration first, effective default
  second, then every remaining model. It never flattens model/effort/access
  combinations into dozens of rows.
- Enter opens that model's configuration editor. Up/Down chooses a field,
  Left/Right cycles values, Enter confirms, and Esc goes back or cancels.
- Codex effort choices come from each model's current `models_cache.json`
  declaration. Claude choices come from the current Claude CLI's global rules;
  Claude full model IDs remain available through the advanced row.
- Dangerous full-access modes require a second explicit Enter confirmation.
- Recent means the last selected `model + effort + access` tuple, never the
  newest released model. Codex also stores its approval policy. On first use,
  the recent row visibly resolves to the effective default tuple. Both rows
  display exact values, source information, and an MRU timestamp when present.
- After selection, the next ordinary prompt is the one-shot task. Other slash
  commands and skill invocations do not consume it. Routing is non-sticky:
  every new task or follow-up must repeat `/codex` or `$claude`.
- Never silently fall back to the host model when a target is unavailable.
- Do not reintroduce task-taxonomy commands such as implement/audit/plan/debug.
- Installation is project-local throughout the explicit scope. For the normal
  setup that scope is `/Users/charliefolder/projects`, including discovered Git
  repos, worktrees, non-Git projects, and the scope-root fallback. Do not write
  global Claude or Codex settings.

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
- `scripts/lib/project-dispatch.mjs` installs exact `/codex` and `$claude`
  discovery artifacts plus project-local hook entries, owns their hashes, and
  preserves unrelated settings and collisions.
- `scripts/install_dispatchers.sh` is the single-project compatibility wrapper
  around the scoped synchronizer.
- `skills/cc-suite/claude/` is the exact Codex-side `$claude` discovery skill;
  the generated `.claude/skills/codex/` artifact is the Claude-side fallback.
- `scripts/dispatch-hook.mjs` intercepts triggers and creates one-shot tickets
  for the next ordinary prompt. `scripts/dispatch-picker.mjs` owns the TTY UI.
- `scripts/lib/dispatch-catalog.mjs` discovers effective defaults and current
  target capabilities. `scripts/lib/dispatch-state.mjs` owns pending selection,
  ticket, TTL, session isolation, and MRU state.
- `scripts/dispatch-execute.mjs` atomically claims a ticket, revalidates the
  selected tuple, preserves the selected subdirectory, and starts one runner.
- `scripts/dispatch-config.mjs` provides a noninteractive diagnostic/config CLI.
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

Validate the `$claude` discovery skill:

```bash
python3 <skill-creator-dir>/scripts/quick_validate.py skills/cc-suite/claude
```

After setup changes, initialize a temporary project twice and confirm:

- the exact `/codex` generated skill and both hook files remain byte-identical
  on the second run;
- `$claude` is visible through `.agents/skills`;
- project state resolves to the project marker while execution keeps the
  user's active subdirectory;
- user-owned exact names, unrelated hooks, and unrelated settings are never
  overwritten or removed.

## Release discipline

This branch is a breaking 3.x redesign because old public task commands and
task-specific Claude skills were removed. Do not tag or push a release unless
the user explicitly authorizes publishing.
