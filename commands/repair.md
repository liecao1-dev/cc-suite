---
description: 重新同步当前项目的 /codex 与 $claude 发送前入口和 hooks
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
同时检查上级 scope 的 composer activation。缺失时给出
`activate-composer.mjs install --scope <scope>`，但不要擅自猜测另一个 scope。
失败时不要回退到发送 selector 消息或消息发送后的编号选择。
