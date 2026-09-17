---
description: 重新同步当前项目入口与范围受限的稳定用户级 hooks
allowed-tools:
  - Bash
---

# 修复当前项目派遣入口

运行：

```bash
scope="${CC_SUITE_SCOPE_ROOT:-$PWD}"
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-projects.mjs" sync \
  --scope "$scope" --project "$PWD" --source "${CLAUDE_PLUGIN_ROOT}"
```

报告创建、更新、移除和冲突项。用户拥有的 `.agents`、`.claude`、Codex/Claude
设置与无关 hook 必须保留；项目里不得生成 cc-suite hook、marker 或 runtime。
同时检查上级 scope 的 composer activation。缺失时给出
`activate-composer.mjs install --scope <scope>`，但不要擅自猜测另一个 scope。
失败时不要回退到发送 selector 消息或消息发送后的编号选择。
