---
name: claude-2-default
description: "显式把任务派遣给 Claude，并使用 Claude Code 默认模型、medium 推理和 default 权限。用户输入 $claude 并在发送前选择“Claude 2｜派遣｜默认配置”时使用。"
---

# Claude 2：默认配置

用户已经在发送前选定本配置。不要再显示配置列表、要求回复编号或增加任务分类。
本次 profile 固定为 `default`，即
`default + medium + permissionMode=default`。

1. 取得同一条消息中 skill 标记之后的原始任务；为空时只询问“这次要 Claude
   做什么？”，拿到任务前不解析或记录配置。
2. 解析当前 skill 的真实目录，运行 `scripts/config.mjs resolve --target claude
   --profile default --cwd "$PWD"`。只解析 stdout JSON；失败就停止，Codex 不得代做。
3. 用返回的三项运行 `scripts/config.mjs record`；失败就停止。
4. 使用高熵且未在任务中单独成行出现的 heredoc 结束符，将任务交给：

   ```bash
   node <this-skill-real-dir>/../../../../scripts/claude-runner.mjs \
     --kind claude-dispatch --model "{model}" --effort "{effort}" \
     --permission-mode "{access}" --timeout-ms 900000 --prompt-stdin \
     <<'CC_SUITE_TASK_<fresh-random-suffix>'
   {task}
   CC_SUITE_TASK_<fresh-random-suffix>
   ```

   runner 从用户当前子目录启动全新 Claude CLI 会话并加入禁止回派 Codex 的边界。
   任务不得拼进 shell 参数；CLI 缺失、未认证或调用失败时明确报错并停止。
5. `completed` 时原样呈现 `rawOutput` 和配置、`jobId`；失败时不要代答或重试。
   最后提醒下一次任务或追问仍要重新输入 `$claude` 并选择配置。
