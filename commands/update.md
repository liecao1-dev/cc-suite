---
description: 更新 cc-suite 后刷新当前项目的发送前候选
allowed-tools:
  - Bash
---

# 刷新当前项目

先显示当前插件版本，再运行：

```bash
node -p "require('${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json').version"
scope="${CC_SUITE_SCOPE_ROOT:-$PWD}"
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-projects.mjs" sync \
  --scope "$scope" --project "$PWD" --source "${CLAUDE_PLUGIN_ROOT}"
```

只报告实际结果。更新稳定启动器时不得改变用户级 hook 定义；不要注册全局 skill
或项目级 Claude MCP，也不要向项目复制 hook 或状态。
