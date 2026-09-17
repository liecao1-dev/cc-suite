---
name: cc-suite
description: "Project instructions for the simple Claude Code ↔ Codex dispatcher."
---

# Project Instructions

> cc-suite simple dispatch

## Product contract

- A manual Claude → Codex dispatch starts by selecting the exact `/codex`
  completion; a manual Codex → Claude dispatch starts by selecting the exact
  `$claude` completion. These are local composer actions, not control messages,
  and must never be submitted.
  Codex versions that render the installed plugin completion as the exact
  `$cc-suite:claude` alias receive identical local handling; the canonical
  user-facing selector remains `$claude`.
- A scope-owned TTY composer proxy consumes the completion key before the stock
  CLI can insert or submit the selector, opens the keyboard picker on
  `/dev/tty`, saves the selection, removes the selector, and inserts a protected
  inline prefix with the target plus exact selected tuple into the stock
  composer. The proxy tracks the real task separately and removes the visual
  prefix immediately before submission. Cancel returns to an empty composer
  with no prefix and nothing armed.
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
- After every field is selected, the visible composer prefix confirms the armed
  target and tuple; the next ordinary prompt is the one-shot task.
  Sending that task is the first and only message submission in the flow and
  immediately consumes the selection. Other slash commands and skill
  invocations do not consume it. Routing is non-sticky: every new task or
  follow-up must select `/codex` or `$claude` again before sending.
- A noninteractive workflow already running inside a cc-suite-managed host may
  invoke only the opposite CLI through its ordinary inference form: Claude may
  call `codex exec`, and Codex may call `claude -p`/`--print`. This automatic
  compatibility path has no picker and does not arm the host `Stop` relay. It
  must enter the same fixed broker, ticket, runner, authentication, sandbox,
  context, deadline, and result machinery as manual dispatch. Unsupported CLI
  flags fail closed instead of silently starting the target binary.
- Before executing a selected task, the host model uses the conversation it
  already has to build a self-contained delegation prompt containing only the
  relevant user/assistant discussion plus the current user prompt verbatim. It
  must not forward hidden instructions, permission data, credentials, raw tool
  transcripts, or unrelated history. A matching target and exact selected
  tuple continues the target conversation bound to that native host session.
  Codex uses native resume; Claude replays a bounded scope-central transcript
  because its print-mode process is non-persistent. Changing the tuple or
  selecting a newer unsupported permission mode starts a fresh compatibility
  call with the same host-supplied context.
- Never silently fall back to the host model when a target is unavailable.
- A successful interactive Codex → Claude dispatch (the `host-relay` delivery)
  preserves the Claude CLI `result` without trimming, then adds exactly one
  final attribution line:
  `回答来自Claude。`. If the raw output already ends with a newline, append the
  attribution directly; otherwise insert one newline first. Codex must not add
  configuration, job metadata, labels, fences, summaries, or reminders. A
  scope-gated user-level Codex `Stop` hook blocks completion until the raw output and
  fixed attribution both match.
- Do not reintroduce task-taxonomy commands such as implement/audit/plan/debug.
- The normal scope is `/Users/charliefolder/projects`, including discovered Git
  repos, worktrees, non-Git projects, and the scope-root fallback. Project roots
  contain only exact selector discovery artifacts; they never receive cc-suite
  hooks, markers, runtime state, or cache directories. Pending selections,
  tickets, conversations, exact relays, recent tuples, and jobs live under the
  single scope-owned `.cc-suite/runtime` root.
- One reversible user-level Codex hook definition and one reversible user-level
  Claude hook definition point to a stable launcher under the scope. The
  launcher enforces the scope before any state access or output, and an unarmed
  prompt exits read-only and silently. Updating cc-suite may replace the owned
  launcher's implementation but must not change either hook definition, so an
  existing Codex hook trust hash remains valid. Preserve all unrelated global
  settings and hooks.
- One reversible, marked PATH block in the user's shell startup file may expose
  the scope shims. They immediately bypass themselves outside the scope. A
  top-level in-scope noninteractive host inference keeps its argv, cwd, stdin,
  and stdout while a private session broker lives with it. An opposite-model
  inference launched by that host is translated to the fixed programmatic
  request adapter. Non-inference commands still bypass unchanged.

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
  scope, installs or removes their selector discovery artifacts, migrates old
  project-local hooks/state, and manages the stable user-level hook entrypoint.
- `scripts/lib/project-dispatch.mjs` installs exact `/codex` and `$claude`
  discovery artifacts, removes only recognizable legacy project hooks and
  markers, and preserves unrelated settings and collisions.
- `scripts/lib/user-dispatch.mjs` owns the stable scope launcher plus merged
  `~/.codex/hooks.json` and `~/.claude/settings.json` entries, plus a stable
  `cc-suite-dispatch` launcher for the strict compatibility adapter. Hook
  commands are invariant across source updates; only owned launcher bodies
  change.
- `scripts/lib/scoped-dispatch.mjs` validates canonical cwd/workspace containment
  and binds all dispatch state to the scope-central runtime root.
- `scripts/install_dispatchers.sh` is the single-project compatibility wrapper
  around the scoped synchronizer.
- `skills/cc-suite/claude/` is the exact Codex-side `$claude` discovery skill;
  the generated `.claude/skills/codex/` artifact is the Claude-side fallback.
- `scripts/composer-proxy.py` owns pre-submit key interception, the protected
  inline configuration prefix, and just-in-time activation for an unmarked
  workspace inside the scope. Before a `$claude` picker opens it performs a
  read-only preflight of the existing Claude subscription credential outside
  the Codex tool sandbox. An expired access token remains eligible when native
  refresh material exists and has not reached its absolute expiry; the real
  inference call then lets the current Claude CLI remain the sole owner of
  refresh-token exchange and Keychain writeback. `auth status --json` is only
  a status command and must never be treated as a refresh operation. The proxy
  itself never reads token contents, rotates tokens, or writes the shared
  credential. It refuses to arm a Claude selection when
  the stored login lacks native refresh material or has reached its absolute
  refresh expiry. The same read-only gate covers a top-level in-scope Claude
  print host; a nested Codex → Claude compatibility request then reaches the
  same Claude runner, where the current CLI can perform native refresh. The
  proxy respects the highlighted completion row, so longer entries
  such as `$claude-workflow-sync` remain independent. An interactive host
  already inside the configured scope receives only the scope-central runtime
  as an additional writable directory so the executor can claim and update its
  one-shot ticket without project-local state. For that host session the proxy
  also owns one private, fixed-purpose Unix-socket broker outside the host tool
  sandbox. The broker fixes the actual host, session, workspace, and only
  permitted opposite target at startup. It accepts either a complete prompt
  plus a valid one-shot ticket or one strictly parsed opposite-CLI compatibility
  request, invokes only cc-suite's fixed dispatcher/executor, and exits with
  the composer; it is not a general command service.
- `scripts/activate-composer.mjs` and
  `scripts/lib/composer-activation.mjs` install, inspect, repair, and safely
  remove the scope-owned CLI shims plus the marked shell PATH block. Each shim
  resolves the currently installed target binary at launch, recovering from a
  package-manager path change without changing either trusted hook definition.
- `scripts/dispatch-select.mjs` opens the picker and binds its complete tuple to
  the current composer session. `scripts/dispatch-hook.mjs` turns the next real
  task into a one-shot ticket, verifies exact Codex → Claude output at `Stop`,
  and only fails closed if a selector is somehow submitted.
  `scripts/dispatch-picker.mjs` owns the TTY UI.
- `scripts/lib/dispatch-catalog.mjs` discovers effective defaults and current
  target capabilities. `scripts/lib/dispatch-state.mjs` owns pending selection,
  ticket, TTL, native-host-to-target conversation bindings, bounded target
  transcripts, exact Claude relay state, session isolation, MRU state, and the
  bounded idempotency registry for programmatic requests. One typed target
  conversation runs at a time; a claimed request that outlives the 60-minute
  runner plus its 30-second persistence allowance becomes a terminal tombstone
  and is never started again.
- `scripts/dispatch-execute.mjs` atomically claims a ticket, revalidates the
  selected tuple, preserves the selected subdirectory, and starts one runner.
  It rejects TTY stdin before reading the task or claiming the ticket. The host
  must prepare the full prompt first, invoke the executor once through closed
  non-TTY stdin, and poll the same command session if it remains active; it must
  never restart a consumed ticket. When the composer broker is present, the
  sandboxed host-side executor relays the still-unclaimed ticket and prompt to
  it; only the broker-side executor may claim the ticket and start the runner.
- `scripts/dispatch-broker.mjs` and
  `scripts/lib/dispatch-broker-client.mjs` provide that authenticated,
  workspace-gated relay. They remove inherited host-sandbox identity before
  launch so the target CLI establishes exactly one sandbox of its own, and
  never fall back to local execution when the configured broker is unavailable.
  The broker, not caller-supplied environment variables, derives the opposite
  target and issues a one-use grant to `scripts/dispatch-request.mjs`.
- `scripts/direct-inference-request.mjs` strictly maps the supported
  `claude -p` and `codex exec` surfaces to that broker-owned programmatic entry.
  `scripts/dispatch-request.mjs` binds a stable request id, prompt hash,
  conversation id, exact tuple, cwd, and delivery mode before creating one
  hidden ticket. A replay with the same bytes returns the same state/result;
  conflicting bytes fail and active conversations report `busy` without a
  queue or duplicate model run.
- `scripts/dispatch-config.mjs` provides a noninteractive diagnostic/config CLI.
- `scripts/lib/dispatch-config.mjs` contains the pure ordering/validation logic.
- `scripts/codex-runner.mjs` provides the deadline-bounded Claude → Codex lane.
- `scripts/claude-runner.mjs` provides the symmetric deadline-bounded
  Codex → Claude lane. It reads the synchronized scope from the scope-owned
  launcher environment, grants that scope as read-only context, and dynamically
  binds writes to the active workspace. The session-local composer broker
  starts it outside the Codex tool sandbox, preventing nested macOS Seatbelt
  profiles while leaving Claude's own sandbox mandatory. Delegated calls fail
  closed unless that Claude sandbox is available, disable unsandboxed command escape, and use a
  `dontAsk` allowlist for workspace edits, `WebSearch`, `WebFetch`, and Klode's
  read-only MCP tools. User/project/local settings sources are excluded so
  stored permissions cannot widen the boundary; the runner forwards only an
  existing `mcpServers.klode` entry from global `~/.claude.json`, never other
  user MCP registrations. Normal dispatch invokes the current Claude CLI bound
  by composer activation, reads its structured terminal result and session ID,
  and retains one last safe restart only when an expired-OAuth result proves
  zero token usage, zero cost, and no model execution. Native refresh happens
  inside that current Claude CLI process; the outer composer only checks
  whether the stored login contains the material needed for that refresh and
  never consumes the rotating token itself. The runner never retries after any
  task work because doing so could duplicate side effects. It uses an explicit
  non-persistent call under the same boundary for every supported permission
  mode.
  `dispatch-execute.mjs` supplies the saved bounded target transcript on later
  matching selections. Normal dispatch does not require project MCP config or
  a separate Agent SDK authentication path.
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

- the exact `/codex` generated skill and both user-level hook definitions remain
  byte-identical on the second run and after changing the source implementation;
- `$claude` is visible through `.agents/skills`;
- selecting either exact completion opens configuration before submission,
  while moving to another completion row does not; the exact tuple appears as a
  protected inline composer prefix but never reaches the submitted task;
- every project resolves state beneath the scope-central runtime while execution
  keeps the user's active subdirectory, and no project marker/runtime is created;
- a completed Codex → Claude call preserves leading/trailing whitespace and a
  Codex `Stop` attempt with any changed raw-output character, missing
  attribution, duplicate attribution, or other addition is continued until it
  exactly matches Claude's raw output followed by `回答来自Claude。`;
- user-owned exact names, unrelated hooks, and unrelated settings are never
  overwritten or removed.
- an outside-scope hook event and an in-scope event with no armed selection both
  produce no output, no message mutation, and no runtime state.
- a direct in-scope Claude print call passes the authentication gate without
  changing its host arguments, cwd, stdin, or stdout; outside-scope and
  non-inference calls bypass it.
- an interactive composer creates a mode-0600 session broker, passes it to the
  host, removes it on exit, rejects requests outside the active workspace, and
  launches the fixed executor without an inherited host-sandbox identity; a
  sandboxed host never claims the ticket before the broker does.
- nested `claude -p` and `codex exec` calls are accepted only from their fixed
  opposite host, preserve complete prompt bytes and selected cwd, share the
  normal 60-minute runner deadline, and replay a stable request id at most once;
  spoofed hosts/targets, changed prompts, unsafe options, concurrent turns on
  one conversation, and late completion after a stalled claim all fail closed.

## Release discipline

This branch is a breaking 3.x redesign because old public task commands and
task-specific Claude skills were removed. Do not tag or push a release unless
the user explicitly authorizes publishing.
