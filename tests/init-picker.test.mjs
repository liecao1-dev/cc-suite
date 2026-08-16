import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const PLUGIN_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const INIT = fs.readFileSync(path.join(PLUGIN_ROOT, "commands", "init.md"), "utf8");

test("init teaches the same pre-send interaction in both hosts", () => {
  assert.match(INIT, /Claude：输入 \/codex 并回车 → 选配置 → 发送任务/);
  assert.match(INIT, /Codex：输入 \$claude 并回车 → 选配置 → 发送任务/);
  assert.match(INIT, /每次新任务或追问都要重新输入目标前缀/);
  assert.doesNotMatch(INIT, /回复 [123]|AskUserQuestion|multiSelect/);
});

test("init uses a project-bounded idempotent synchronizer", () => {
  assert.match(INIT, /scripts\/sync-projects\.mjs/);
  assert.match(INIT, /--scope "\$PWD" --project "\$PWD"/);
  assert.match(INIT, /检查 `node`、`codex` 和 `claude`/);
  assert.match(INIT, /缺失时明确报错并停止/);
  assert.doesNotMatch(INIT, /mcp_claude|mcp_codex|bridge_tools/);
});
