---
name: claude-4-opus
description: "显式把任务派遣给 Claude Opus，并使用 medium 推理和 default 权限。用户输入 $claude 并在发送前选择“Claude 4｜派遣｜Opus”时使用。"
---

# Claude 4：Opus

用户已在发送前选定 `model:opus`，即
`opus + medium + permissionMode=default`。不得再显示列表、询问编号或增加任务分类。

1. 取得同一条消息中 skill 标记之后的原始任务；为空时只询问任务，拿到前停止。
2. 从当前 skill 真实目录运行 `scripts/config.mjs resolve --target claude
   --profile model:opus --cwd "$PWD"`，只接受 `status=ok`。
3. 任务非空后，用返回的三项运行 `scripts/config.mjs record`，失败就停止。
4. 用高熵 heredoc 将任务通过 stdin 交给
   `<this-skill-real-dir>/../../../../scripts/claude-runner.mjs`，参数为
   `--kind claude-dispatch --model "{model}" --effort "{effort}"
   --permission-mode "{access}" --timeout-ms 900000 --prompt-stdin`。
   runner 从当前子目录启动全新 Claude CLI 调用并加入禁止回派 Codex 的固定边界。
5. 成功时原样呈现 `rawOutput`、配置和 `jobId`；CLI 缺失、未认证或调用失败时
   明确报错，Codex 不得代答或重试。
6. 最后提醒下一次任务或追问仍要重新输入 `$claude` 并在发送前选择配置。
