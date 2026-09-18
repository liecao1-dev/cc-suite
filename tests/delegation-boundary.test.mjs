import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  CLAUDE_DELEGATION_BOUNDARY,
  DELEGATING_SKILLS,
  BOUNDARY_INVARIANTS,
  DELEGATION_BOUNDARY,
  withDelegationBoundary,
  withClaudeDelegationBoundary,
} from "../scripts/lib/delegation-boundary.mjs";

const PLUGIN_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);

function readScript(name) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", name), "utf8");
}

test("the boundary names every skill that delegates back to Claude", () => {
  assert.deepEqual(DELEGATING_SKILLS, ["claude"]);
  assert.ok(
    /do not activate or invoke the \$claude workspace skill/i.test(DELEGATION_BOUNDARY),
    "Boundary should forbid both activation and invocation"
  );
});

test("the boundary contains its own invariant sentences", () => {
  for (const sentence of BOUNDARY_INVARIANTS) {
    assert.ok(
      DELEGATION_BOUNDARY.includes(sentence),
      `Boundary text is missing invariant: ${sentence}`
    );
  }
});

test("withDelegationBoundary prefixes the prompt without losing it", () => {
  const prompted = withDelegationBoundary("Audit src/parser.ts");
  assert.ok(prompted.startsWith(DELEGATION_BOUNDARY));
  assert.ok(prompted.endsWith("Audit src/parser.ts"));
  // Blank line between boundary and task so neither bleeds into the other.
  assert.ok(prompted.includes(`${DELEGATION_BOUNDARY}\n\nAudit`));
});

test("withDelegationBoundary tolerates an empty prompt", () => {
  assert.equal(withDelegationBoundary(""), DELEGATION_BOUNDARY);
  assert.equal(withDelegationBoundary("   "), DELEGATION_BOUNDARY);
  assert.equal(withDelegationBoundary(undefined), DELEGATION_BOUNDARY);
});

test("the agy, Grok, and Qwen runners apply the boundary", () => {
  for (const script of ["agy-runner.mjs", "grok-runner.mjs", "qwen-runner.mjs"]) {
    const source = readScript(script);
    assert.match(
      source,
      /from "\.\/lib\/delegation-boundary\.mjs"/,
      `${script} should import the shared boundary`
    );
    assert.match(
      source,
      /withDelegationBoundary\(/,
      `${script} should apply the boundary to the delegated prompt`
    );
  }
});

test("the boundary is applied where the child is invoked, not where args parse", () => {
  // The background path re-spawns the runner with the original prompt. Applying
  // the boundary during parseArgs would stack a second copy onto every
  // backgrounded run, so the call must sit outside parseArgs.
  for (const script of ["agy-runner.mjs", "grok-runner.mjs", "qwen-runner.mjs"]) {
    const source = readScript(script);
    const parseStart = source.indexOf("function parseArgs");
    assert.ok(parseStart !== -1, `${script} should define parseArgs`);

    // End of parseArgs = the next top-level `function` declaration after it.
    const afterParse = source.indexOf("\nfunction ", parseStart + 1);
    const parseBody = source.slice(parseStart, afterParse);
    assert.doesNotMatch(
      parseBody,
      /withDelegationBoundary/,
      `${script} must not apply the boundary inside parseArgs`
    );
  }
});

test("both direct CLI runners apply the correct no-bounce boundary", () => {
  const codexRunner = readScript("codex-runner.mjs");
  const claudeRunner = readScript("claude-runner.mjs");
  assert.match(codexRunner, /withDelegationBoundary\(args\.prompt\)/);
  // The normal Claude prompt includes document-tool guidance before the task.
  // claude-runner.test.mjs also checks the prompt received by the fake native CLI.
  assert.match(claudeRunner, /withClaudeDelegationBoundary\(\s*\[documentTools\.instructions, args\.prompt\]\.filter\(Boolean\)\.join\("\\n\\n"\),?\s*\)/);
  for (const sentence of BOUNDARY_INVARIANTS) {
    assert.ok(DELEGATION_BOUNDARY.includes(sentence));
    assert.ok(CLAUDE_DELEGATION_BOUNDARY.includes(sentence));
  }
  assert.match(DELEGATION_BOUNDARY, /\$claude workspace skill/);
  assert.match(CLAUDE_DELEGATION_BOUNDARY, /\/codex workspace skill/);
  assert.ok(withClaudeDelegationBoundary("task").endsWith("task"));
});
