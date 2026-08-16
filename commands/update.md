---
description: 更新 cc-suite 后刷新当前项目的发送前候选
allowed-tools:
  - Bash
---

# 刷新当前项目

先显示当前插件版本，再运行：

```bash
node -p "require('${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json').version"
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-projects.mjs" sync \
  --scope "$PWD" --project "$PWD" --source "${CLAUDE_PLUGIN_ROOT}"
```

只报告实际结果。不要注册全局 hook、全局 skill 或项目级 Claude MCP。
