---
description: 读取一个已经结束的 Codex 派遣 job 的保存结果
argument-hint: "[job-id]"
---

# cc-suite result

```bash
node -e "
  const { resolveResultJob, readStoredJob } = await import('${CLAUDE_PLUGIN_ROOT}/scripts/lib/job-control.mjs');
  try {
    const reference = process.argv[1] || undefined;
    const { workspaceRoot, job } = resolveResultJob(process.cwd(), reference);
    const stored = readStoredJob(workspaceRoot, job.id);
    console.log(JSON.stringify({ job, stored }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
" -- "$ARGUMENTS"
```

命令失败时原样转述错误。成功时显示 job id、状态、时长、本次配置和 Codex 原始
输出。结果缺失时说明可能已被清理。

不要按 audit/implement 等旧 kind 推荐下一步，也不要推荐 `/continue`。用户要追问
或继续干活时，提醒重新输入 `/codex <任务>`，并重新选择配置。
