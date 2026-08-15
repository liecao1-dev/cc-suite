// delegation-boundary.mjs — Stop a delegated agent handing the work back.
//
// bridge_skills.sh points .agents/skills at ../.claude/skills, and every agent
// cc-suite delegates to (Codex, Antigravity, Grok, and the other AGENTS.md
// readers) loads workspace skills from there. That tree contains cc-suite's
// explicit `$claude` dispatcher. A Codex session that Claude itself spawned can
// therefore route the request straight back to its author. The independent
// judgment collapses into self-review.
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
// The /codex command assembles its preamble from prose in commands/codex.md
// instead of calling this module. BOUNDARY_INVARIANTS exists so a test can hold
// that copy and this one to the same promise.

// Skills whose whole purpose is to delegate to Claude Code.
export const DELEGATING_SKILLS = Object.freeze([
  "claude",
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
  "Do not activate or invoke the $claude workspace skill or otherwise hand the task back to Claude Code.",
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
