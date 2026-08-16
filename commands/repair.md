---
description: 重新同步当前项目的 /codex 与 $claude 发送前候选
allowed-tools:
  - Bash
---

# 修复当前项目派遣入口

运行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-projects.mjs" sync \
  --scope "$PWD" --project "$PWD" --source "${CLAUDE_PLUGIN_ROOT}"
```

报告创建、更新、移除和冲突项。用户拥有的 `.agents`、`.claude` 内容必须保留；
失败时不要回退到消息发送后的编号选择。
