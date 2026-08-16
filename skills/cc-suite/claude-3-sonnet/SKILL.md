---
name: claude-3-sonnet
description: "显式把任务派遣给 Claude Sonnet，并使用 medium 推理和 default 权限。用户输入 $claude 并在发送前选择“Claude 3｜派遣｜Sonnet”时使用。"
---

# Claude 3：Sonnet

用户已经在发送前选定本配置。不要再显示配置列表、要求回复编号或增加任务分类。
本次 profile 固定为 `model:sonnet`，即
`sonnet + medium + permissionMode=default`。

1. 取得同一条消息中 skill 标记之后的原始任务；为空时只询问“这次要 Claude
   做什么？”，拿到任务前不解析或记录配置。
2. 解析当前 skill 的真实目录，运行 `scripts/config.mjs resolve --target claude
   --profile model:sonnet --cwd "$PWD"`。只解析 stdout JSON；失败就停止。
3. 用返回的三项运行 `scripts/config.mjs record`；失败就停止。
4. 用高熵 heredoc 将任务通过 stdin 交给
   `<this-skill-real-dir>/../../../../scripts/claude-runner.mjs`，参数为
   `--kind claude-dispatch --model "{model}" --effort "{effort}"
   --permission-mode "{access}" --timeout-ms 900000 --prompt-stdin`。
   runner 必须从用户当前子目录启动全新 Claude CLI 调用，并加入禁止回派 Codex
   的固定边界。任务不得拼进 shell 参数，不使用旧会话。
5. `completed` 时原样呈现 `rawOutput` 和配置、`jobId`；CLI 缺失、未认证、
   `failed` 或 `stalled` 时明确报错，Codex 不得代答或重试。
6. 最后提醒下一次任务或追问仍要重新输入 `$claude` 并在发送前选择配置。
