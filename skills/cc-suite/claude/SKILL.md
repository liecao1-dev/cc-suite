---
name: claude
description: "显式把任意问题或工作派遣给 Claude Code。仅当用户写出 $claude 并给出任务时使用；每次派遣都必须重新让用户选择模型、推理强度和权限配置。"
---

# Claude

`$claude <任务>` 是 Codex → Claude 的唯一日常派遣入口。用户直接用大白话写
任务；不要要求 `review`、`plan`、`implement`、`debug` 等工作流分类。

## 派遣契约

- 只有用户显式写出 `$claude` 才能派遣，不得隐式触发。
- 每次派遣必须重新选择完整配置；最近配置只排在第一位，绝不能自动使用。
- 最近配置是上次选择的 `model + effort + permissionMode`，不是最新发布模型。
- 本次任务开一个新的 Claude 会话。不要用 `claude_code_reply` 隐式续接旧会话。
- Claude MCP 不可用或调用失败时明确报错并停止；Codex 不得假装成 Claude 代做。
- 本次完成后，任何新任务或追问都必须再次以 `$claude ...` 开头。

用户对配置选择问题的回答属于本次尚未发出的派遣，不要求重复 `$claude`。

## 工作流

### 1. 保留任务

把 `$claude` 后面的内容按原意保存为 `{task}`。如果为空，先询问任务内容；在
任务和配置都明确前不要调用任何 Claude MCP 工具。

### 2. 加载配置选项

解析当前 skill 的真实目录，运行其 `scripts/config.mjs`：

```bash
node <this-skill-dir>/scripts/config.mjs list --target claude --cwd "$PWD"
```

只解析 stdout JSON。`status` 不为 `ok` 时显示 `error` 并停止。

`profiles` 已按不可更改的顺序排列：最近配置、默认配置、其余模型。最近与默认
完全相同时已合并。不得自行重排，也不得因为只有一个选项就自动选择。

### 3. 每次都让用户选择

优先使用当前 Codex 界面提供的用户选择工具弹出单选；若本轮没有该工具，则显示
短编号列表并停止本轮，等用户回答后继续。两种方式都遵守：

- 标题和说明取自 `profiles`，顺序保持不变；依据 `badges` 在标题前标注
  `最近 · `、`默认 · ` 或 `最近且默认 · `。
- 使用 Codex 的选择工具时首屏最多三项；若界面另有明确上限则遵循该上限。
  列出其余模型 slug，并允许用户通过 `Other` 或文字回答输入。
- 用户可输入 profile id、模型 slug，或 `model / effort / permission`。
- 只输入模型时，再询问 `effort` 和 `permission`；不要替用户猜。
- 三个字段都必须在 `capabilities` 中有效。Claude 的权限仅可选
  `default`、`acceptEdits`、`plan`。
- 不把某一项标成会被自动采用；“默认”只是排序标签。

### 4. 记录并派遣

选择有效后先运行：

```bash
node <this-skill-dir>/scripts/config.mjs record \
  --target claude --cwd "$PWD" \
  --model "{model}" --effort "{effort}" --access "{permission}"
```

仅在返回 `status: ok` 后调用 `mcp__claude-code__claude_code`：

```yaml
prompt: |-
  This request already reached you by delegation from OpenAI Codex. You are the
  agent that does the work, not a router for it. Perform the task yourself and
  return the result directly. Do not invoke a workspace skill that hands the task
  back to Codex. Apply independent judgment.

  USER TASK:
  {task}
cwd: {current working directory}
model: {model; omit this field when model is "default"}
effort: {effort}
permissionMode: {permission}
```

不要增加 review/plan/implement/debug 模板，不要改写成另一类任务。保存返回的
`session_id` 仅供诊断，不在下一次调用中自动复用。

### 5. 返回结果

呈现 Claude 的结果，并列出本次配置。若 MCP 工具不存在，告诉用户先运行
`/cc-suite:init` 或修复 `[mcp_servers.claude-code]`，然后停止，不得本地代答。
最后提醒：下一次派遣请重新输入 `$claude <任务>`。

## 示例

```text
$claude 帮我找出这个登录流程为什么偶尔卡住
$claude 把 README 改得让新手能直接照着安装
$claude 判断这套数据库迁移方案有没有漏项
```

这三种任务都走同一个入口；差别只在用户写的自然语言和本次手动选择的配置。
