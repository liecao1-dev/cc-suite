---
name: claude-3-sonnet
description: "显式把任务派遣给 Claude Sonnet，并使用 medium 推理和 default 权限。用户输入 $claude 并在发送前选择“Claude 3｜派遣｜Sonnet”时使用。"
---

# Claude 3：Sonnet

用户已经在 Codex 输入框的 `$claude` 候选菜单里选定了本配置。不要再显示配置
列表，不要要求回复编号，也不要改成 review、plan、implement 或 debug 工作流。

## 本次固定选择

运行时 profile 为 `model:sonnet`，即
`sonnet + medium + permissionMode=default`。

## 执行

1. 取得同一条用户消息中 skill 标记之后的原始任务。若任务为空，只询问：
   “这次要 Claude 做什么？”。任务为空或用户取消时停止，不记录配置。
2. 解析当前 skill 的真实目录，运行：

   ```bash
   node <this-skill-dir>/scripts/config.mjs resolve \
     --target claude --profile model:sonnet --cwd "$PWD"
   ```

   只解析 stdout JSON。`status` 不为 `ok` 时显示 `error` 并停止；不得改由
   Codex 代做。使用返回的 `config.model`、`config.effort` 和 `config.access`。
3. 在任务非空后运行 `config.mjs record`，传入 `--target claude --cwd "$PWD"`
   以及返回的 `--model`、`--effort`、`--access`。仅在返回 `status: ok` 后继续。
4. 调用 `mcp__claude-code__claude_code`：

   ```yaml
   prompt: |-
     This request already reached you by delegation from OpenAI Codex. You are
     the agent that does the work, not a router for it. Perform the task
     yourself and return the result directly. Do not hand the task back to
     Codex. Apply independent judgment.

     USER TASK:
     {task}
   cwd: {current working directory}
   model: {model}
   effort: {effort}
   permissionMode: {access}
   ```

   每次创建新 Claude 会话，不使用 `claude_code_reply`。MCP 缺失或失败时明确
   报错并停止。
5. 返回 Claude 的结果和本次实际配置。最后提醒：下一次派遣请重新输入
   `$claude`，在发送前选择配置。
