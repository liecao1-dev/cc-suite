---
description: 把任意问题或工作直接派遣给 Codex；每次都先选择模型、推理强度和沙盒配置
argument-hint: "<用大白话写任务>"
allowed-tools:
  - Bash
  - AskUserQuestion
---

# /codex

这是 Claude → Codex 的唯一日常派遣入口。`$ARGUMENTS` 是用户要交给
Codex 的原始任务，不是工作流名称，也不需要 `implement`、`audit`、
`review-plan` 等分类。

## 不可破坏的规则

1. 每次执行本命令都必须重新选择配置；不得静默沿用最近配置，也不得自动选择默认配置。
2. “最近配置”只表示上一次实际选择的 `model + effort + sandbox`，不表示最新发布的模型。
3. 本次任务使用全新 Codex 会话，不隐式续接旧线程。
4. Codex 不可用或调用失败时，明确报错并停止；不得让 Claude 冒充 Codex 完成任务。
5. 完成本次派遣后，用户的下一次任务（包括追问）仍须重新写 `/codex ...`。

## 第一步：确认任务

将下面内容按原意保留为 `{task}`：

```text
$ARGUMENTS
```

如果去掉首尾空白后为空，询问用户要 Codex 做什么；拿到任务前不要运行任何派遣。

## 第二步：读取按顺序排列的配置

运行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch-config.mjs" list --target codex --cwd "$PWD"
```

只解析 stdout 的 JSON。若 `status` 不是 `ok`，显示 `error` 及建议修复方式并停止。
不得回退到 Claude。

`profiles` 已严格排好顺序：最近配置在最上，默认配置第二，其余模型在后；
最近与默认完全相同时会合并成一项。不要自行重新排序。

## 第三步：弹出配置选择

始终调用 `AskUserQuestion`，即使当前只有一个可选配置也不能自动选。

- 问题：`这次让 Codex 使用哪套配置？`
- 按 `profiles` 顺序放入选项，最多四项。
- 选项标题使用 `label`；说明使用 `description`。带 `recent` badge 的标题前加
  `最近 · `，带 `default` badge 的标题前加 `默认 · `；两者都有则写
  `最近且默认 · `。
- 问题正文列出因四项上限而未显示的模型 slug，并说明可通过 `Other` 输入。

如果用户通过 `Other` 输入：

- 输入某个现有 profile id 或模型 slug：选择对应项；若只给了模型，再用
  `AskUserQuestion` 让用户选择该模型支持的 `effort` 和 `sandbox`。
- 输入 `model / effort / sandbox`：按 `capabilities` 校验三项。
- 输入无效：说明具体哪一项无效并重新询问。不得替用户修正或猜测。

若用户选择 `danger-full-access`，额外确认一次其含义是 Codex 将拥有不受沙盒
限制的文件和命令访问；用户不确认就改为重新选择配置。

## 第四步：记录选择

在真正调用前运行下面命令。三个值只能来自已经校验的配置，不得把原始任务拼进命令：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch-config.mjs" record \
  --target codex --cwd "$PWD" \
  --model "{chosen_model}" --effort "{chosen_effort}" --access "{chosen_sandbox}"
```

必须确认返回 `status: ok`；否则显示错误并停止。

## 第五步：派遣原始任务

通过 deadline-bounded runner 发起一次全新调用，不使用 `--resume`，也不增加
任务类型模板：

下面示意中的 heredoc 结束符每次都生成一个新的高熵随机值，并确认它没有作为独立
一行出现在 `{combined_prompt}` 中。结束符必须用单引号包住，使任务中的反引号、
`$()`、引号和换行都只作为文本通过 stdin 传入，不能被 shell 执行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-runner.mjs" \
  --kind dispatch \
  --model "{chosen_model}" \
  --effort "{chosen_effort}" \
  --sandbox "{chosen_sandbox}" \
  --timeout-ms 900000 \
  --summary "codex dispatch" \
  --prompt-stdin <<'CC_SUITE_PROMPT_<fresh-random-suffix>'
{combined_prompt}
CC_SUITE_PROMPT_<fresh-random-suffix>
```

`{combined_prompt}` 由下面的固定边界和 `{task}` 原文组成，不要擅自把它改造成
implement、audit、review 等模板：

```text
This request already reached you by delegation from Claude Code. You are the agent that does the work, not a router for it. Perform the task yourself and return the result directly. Do not invoke any $claude-* workspace skill or otherwise hand the task back to Claude Code. Returning this work to its author would destroy the independent judgment this call exists to provide.

USER TASK:
{task}
```

## 第六步：返回结果

- `status=completed`：原样呈现 `rawOutput`，随后简短列出本次配置和 `jobId`。
- `status=failed` 或 `stalled`：显示 `error`、`jobId` 以及
  `/cc-suite:status {jobId}`；不要自动重试，不要由 Claude 代答。
- 可以保留 `threadId` 作为内部诊断信息，但不要引导用户用旧的 `/continue`。
- 最后提醒一次：下一次派遣请重新输入 `/codex <任务>`。
