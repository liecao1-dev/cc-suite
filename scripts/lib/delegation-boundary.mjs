// delegation-boundary.mjs — Stop a delegated agent handing the work back.
//
// bridge_skills.sh exposes the explicit `$claude` configuration entries
// directly under .agents/skills/claude-*. A Codex session that Claude itself
// spawned can see them and could route the request straight back to its author. The independent
// judgment would then collapse into self-review.
//
// Two levers close this, and each covers what the other cannot:
//
//   1. Implicit-invocation guards. skills/cc-suite/<skill>/agents/openai.yaml
//      sets allow_implicit_invocation: false so the skill cannot fire on its
//      own. Codex-only: Antigravity's skill schema accepts nothing but `name`
//      and `description`, so it has no equivalent switch, and the guard cannot
//      stop an agent that reaches for the skill deliberately.
//
//   2. This boundary, injected into the prompt. Tool-agnostic and effective
//      against deliberate use, so it is the only lever available on the agy,
//      Grok, and bounded Qwen-review lanes. Applied in code rather than left to
//      the calling command,
//      because it has to hold on every call — foreground, background, resume.
//
// Both CLI runners apply their boundary at the child-process edge. Generated
// picker skills therefore pass only the user's task and cannot accidentally
// omit, duplicate, or weaken the no-bounce rule.

// Skills whose whole purpose is to delegate to Claude Code.
export const DELEGATING_SKILLS = Object.freeze([
  "claude-1-recent",
  "claude-2-default",
  "claude-3-sonnet",
  "claude-4-opus",
  "claude-5-haiku",
]);

// Each invariant sentence is defined exactly once so the canonical copy in
// BOUNDARY_INVARIANTS and the prompt copy in DELEGATION_BOUNDARY cannot drift.
const INVARIANT_WORKER_NOT_ROUTER =
  "You are the agent that does the work, not a router for it.";
const INVARIANT_NO_RETURN_TO_AUTHOR =
  "Returning this work to its author would destroy the independent judgment this call exists to provide.";

// Sentences every lane's boundary must contain, whether it comes from this
// module or from the Codex preamble prose. Enforced by
// tests/delegation-guard.test.mjs.
export const BOUNDARY_INVARIANTS = Object.freeze([
  INVARIANT_WORKER_NOT_ROUTER,
  INVARIANT_NO_RETURN_TO_AUTHOR,
]);

// "activate or invoke" covers both vocabularies: Codex invokes a skill
// explicitly, Antigravity activates one after reading its description.
export const DELEGATION_BOUNDARY = [
  "This request already reached you by delegation from Claude Code.",
  INVARIANT_WORKER_NOT_ROUTER,
  "Perform the analysis yourself and return the result directly.",
  "Do not activate or invoke any $claude-* workspace skill or otherwise hand the task back to Claude Code.",
  INVARIANT_NO_RETURN_TO_AUTHOR,
].join(" ");

export const CLAUDE_DELEGATION_BOUNDARY = [
  "This request already reached you by delegation from OpenAI Codex.",
  INVARIANT_WORKER_NOT_ROUTER,
  "Perform the task yourself and return the result directly.",
  "Do not invoke any /codex-* workspace skill or otherwise hand the task back to Codex.",
  INVARIANT_NO_RETURN_TO_AUTHOR,
].join(" ");

/**
 * Prefix a delegated prompt with the boundary.
 *
 * Call this where the prompt is handed to the child process, not where it is
 * parsed: the background path re-spawns the runner with the original prompt, so
 * prefixing at parse time would stack a second copy on every backgrounded run.
 *
 * @param {string} prompt
 * @returns {string}
 */
export function withDelegationBoundary(prompt) {
  if (!prompt || !prompt.trim()) return DELEGATION_BOUNDARY;
  return `${DELEGATION_BOUNDARY}\n\n${prompt}`;
}

export function withClaudeDelegationBoundary(prompt) {
  if (!prompt || !prompt.trim()) return CLAUDE_DELEGATION_BOUNDARY;
  return `${CLAUDE_DELEGATION_BOUNDARY}\n\n${prompt}`;
}
