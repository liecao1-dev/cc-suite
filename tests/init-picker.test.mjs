import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const PLUGIN_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);
const INIT = fs.readFileSync(
  path.join(PLUGIN_ROOT, "commands", "init.md"),
  "utf8"
);

// Initialization is intentionally boring: it always wires the two supported
// directions. Model/profile choice belongs to each dispatch, not setup.

test("init exposes exactly the Claude-to-Codex and Codex-to-Claude directions", () => {
  assert.match(INIT, /Claude 里用 `\/codex <任务>`/);
  assert.match(INIT, /Codex 里先输入 `\$claude`/);
  assert.match(INIT, /发送前选配置、追加任务/);
  assert.doesNotMatch(INIT, /multiSelect:\s*true/);
  assert.doesNotMatch(INIT, /bridge_tools\.py"? --set-enabled/);
});

test("init installs both dispatch channels without a model picker", () => {
  for (const script of ["init.sh", "mcp_codex.sh", "mcp_claude.sh"]) {
    assert.match(INIT, new RegExp(`scripts/${script.replace(".", "\\.")}`));
  }
  assert.match(INIT, /模型配置不在初始化时锁定/);
  assert.match(INIT, /每次派遣都从输入框候选中重新选择/);
  assert.match(INIT, /发送后不再要求回复编号/);
});

test("init requires real local dependencies and fails instead of falling back", () => {
  assert.match(INIT, /command -v codex/);
  assert.match(INIT, /若 `codex` 缺失/);
  assert.match(INIT, /停止/);
  assert.doesNotMatch(INIT, /自动回退/);
});

test("init summary teaches only the two plain-language entry points", () => {
  const summary = INIT.slice(INIT.indexOf("## 6."));
  assert.match(summary, /Claude：\/codex <用大白话写任务>/);
  assert.match(summary, /Codex：输入 \$claude → 选配置 → 追加大白话任务 → 回车/);
  assert.match(summary, /每次都会重新选配置；发送后不再回复编号/);
  assert.doesNotMatch(summary, /Not bridged|bridge-tools/);
});
