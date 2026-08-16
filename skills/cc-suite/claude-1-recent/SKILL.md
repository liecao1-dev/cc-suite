---
name: claude-1-recent
description: "显式把任务派遣给 Claude，并使用本项目上一次选择的完整配置；第一次使用时采用默认配置。用户输入 $claude 并在发送前选择“Claude 1｜派遣｜最近配置”时使用。"
---

# Claude 1：最近配置

用户已经在 Codex 输入框的 `$claude` 候选菜单里选定了本配置。不要再显示配置
列表，不要要求回复编号，也不要改成 review、plan、implement 或 debug 工作流。

运行时 profile 为 `recent`：读取本项目上次实际选择的
`model + effort + permissionMode`；若尚无记录，明确回落到
`default + medium + permissionMode=default`。

1. 取得同一条消息中 skill 标记之后的原始任务。若任务为空，只询问“这次要
   Claude 做什么？”。任务为空或用户取消时停止，不记录配置。
2. 解析当前 skill 的真实目录，运行 `scripts/config.mjs resolve --target claude
   --profile recent --cwd "$PWD"`。只解析 stdout JSON；`status` 不为 `ok` 时
   显示错误并停止，不得由 Codex 代做。
3. 任务非空后，用解析出的三项运行 `scripts/config.mjs record`；记录失败就停止。
4. 用高熵且未在任务中单独成行出现的 heredoc 结束符运行：

   ```bash
   node <this-skill-real-dir>/../../../../scripts/claude-runner.mjs \
     --kind claude-dispatch \
     --model "{model}" \
     --effort "{effort}" \
     --permission-mode "{access}" \
     --timeout-ms 900000 \
     --prompt-stdin <<'CC_SUITE_TASK_<fresh-random-suffix>'
   {task}
   CC_SUITE_TASK_<fresh-random-suffix>
   ```

   runner 会在用户当前子目录启动一次全新 Claude CLI 调用，并在子进程边界加入
   “不得把任务派回 Codex”的固定提示。任务不得拼进 shell 参数，不使用旧会话。
5. `completed` 时原样呈现 `rawOutput` 并列出配置与 `jobId`；`failed` 或
   `stalled` 时显示错误并停止，不要自动代答或重试。若 `usedInitialDefault=true`，
   说明“本项目尚无最近配置，本次使用默认配置”。
6. 最后提醒：下一次任务或追问仍要重新输入 `$claude` 并在发送前选择配置。
