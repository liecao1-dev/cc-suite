---
name: claude-1-recent
description: "显式把任务派遣给 Claude，并使用本项目上一次选择的完整配置；第一次使用时采用默认配置。用户输入 $claude 并在发送前选择“Claude 1｜派遣｜最近配置”时使用。"
---

# Claude 1：最近配置

用户已经在 Codex 输入框的 `$claude` 候选菜单里选定了本配置。不要再显示配置
列表，不要要求回复编号，也不要改成 review、plan、implement 或 debug 工作流。

## 本次固定选择

运行时 profile 为 `recent`。它读取本项目上次实际派遣的
`model + effort + permissionMode`；若项目还没有记录，首次明确采用
`default + medium + permissionMode=default`。这只是首次回落，不是静默替用户
挑选最新模型。

## 执行

1. 取得同一条用户消息中 skill 标记之后的原始任务。若任务为空，只询问：
   “这次要 Claude 做什么？”。任务为空或用户取消时停止，不记录配置。
2. 解析当前 skill 的真实目录，运行：

   ```bash
   node <this-skill-dir>/scripts/config.mjs resolve \
     --target claude --profile recent --cwd "$PWD"
   ```

   只解析 stdout JSON。`status` 不为 `ok` 时显示 `error` 并停止；不得改由
   Codex 代做。使用返回的 `config.model`、`config.effort` 和 `config.access`。
3. 在任务非空后记录本次实际配置：

   ```bash
   node <this-skill-dir>/scripts/config.mjs record \
     --target claude --cwd "$PWD" \
     --model "{model}" --effort "{effort}" --access "{access}"
   ```

   仅在返回 `status: ok` 后继续。
4. 调用 `mcp__claude-code__claude_code`，参数如下：

   ```yaml
   prompt: |-
     This request already reached you by delegation from OpenAI Codex. You are
     the agent that does the work, not a router for it. Perform the task
     yourself and return the result directly. Do not hand the task back to
     Codex. Apply independent judgment.

     USER TASK:
     {task}
   cwd: {current working directory}
   model: {model; omit this field when model is "default"}
   effort: {effort}
   permissionMode: {access}
   ```

   每次创建新 Claude 会话，不使用 `claude_code_reply` 续接旧会话。MCP 缺失或
   调用失败时明确报错并停止。
5. 返回 Claude 的结果和本次实际配置。若 `usedInitialDefault` 为 `true`，说明
   “本项目尚无最近配置，本次使用默认配置”。最后提醒：下一次派遣请重新输入
   `$claude`，在发送前选择配置。
