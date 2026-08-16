---
name: cc-suite
description: "Project instructions for the simple Claude Code ↔ Codex dispatcher."
---

# Project Instructions

> cc-suite simple dispatch

## Product contract

- Claude → Codex starts by selecting the exact `/codex` completion; Codex →
  Claude starts by selecting the exact `$claude` completion. These are local
  composer actions, not control messages, and must never be submitted.
- A scope-owned TTY composer proxy consumes the completion key before the stock
  CLI can insert or submit the selector, opens the keyboard picker on
  `/dev/tty`, saves the selection, removes the selector, and returns to an empty
  composer. Cancel returns to the empty composer with nothing armed.
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
- After every field is selected, the next ordinary prompt is the one-shot task.
  Sending that task is the first and only message submission in the flow and
  immediately consumes the selection. Other slash commands and skill
  invocations do not consume it. Routing is non-sticky: every new task or
  follow-up must select `/codex` or `$claude` again before sending.
- Never silently fall back to the host model when a target is unavailable.
- Do not reintroduce task-taxonomy commands such as implement/audit/plan/debug.
- Project hooks, state, launchers, and proxy shims live inside the explicit
  scope. For the normal setup that scope is `/Users/charliefolder/projects`,
  including discovered Git repos, worktrees, non-Git projects, and the
  scope-root fallback. One reversible, marked PATH block in the user's shell
  startup file may expose the scope shims; they immediately bypass themselves
  outside the scope and for noninteractive calls. Do not write global Claude or
  Codex settings.

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
- `scripts/composer-proxy.py` owns pre-submit key interception. It respects the
  highlighted completion row, so longer entries such as
  `$claude-workflow-sync` remain independent.
- `scripts/activate-composer.mjs` and
  `scripts/lib/composer-activation.mjs` install, inspect, repair, and safely
  remove the scope-owned CLI shims plus the marked shell PATH block.
- `scripts/dispatch-select.mjs` opens the picker and binds its complete tuple to
  the current composer session. `scripts/dispatch-hook.mjs` turns the next real
  task into a one-shot ticket and only fails closed if a selector is somehow
  submitted. `scripts/dispatch-picker.mjs` owns the TTY UI.
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
- selecting either exact completion opens configuration before submission,
  while moving to another completion row does not;
- project state resolves to the project marker while execution keeps the
  user's active subdirectory;
- user-owned exact names, unrelated hooks, and unrelated settings are never
  overwritten or removed.

## Release discipline

This branch is a breaking 3.x redesign because old public task commands and
task-specific Claude skills were removed. Do not tag or push a release unless
the user explicitly authorizes publishing.
