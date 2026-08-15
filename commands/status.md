---
description: 查看 Claude ↔ Codex 桥接健康状态以及当前和最近的 Codex 派遣 job
argument-hint: "[job-id] [--all] [--json]"
---

# cc-suite status

先运行桥接状态：

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/status.sh"
```

再用 job-control 读取派遣状态：

```bash
node -e "
  const { buildStatusSnapshot } = await import('${CLAUDE_PLUGIN_ROOT}/scripts/lib/job-control.mjs');
  console.log(JSON.stringify(buildStatusSnapshot(process.cwd(), { all: process.argv[1] === '--all' }), null, 2));
" -- "$ARGUMENTS"
```

默认显示 active、latest finished 和 recent jobs。若指定 job id，显示对应任务；
`--json` 时直接返回结构化 JSON。

没有 job 时写：`还没有派遣记录。使用 /codex <任务> 发起一次。`

不要显示已移除的 review gate，不要推荐 `/continue` 或任何任务型命令。每个完成
job 的后续任务都应重新使用 `/codex <任务>`。
