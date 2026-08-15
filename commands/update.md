---
description: 更新插件后刷新 /codex、$claude 和锁定的 claude-octopus MCP 配置
---

# cc-suite update

此命令不替代 `claude plugin update cc-suite@xiaolai`。先读取并显示当前插件版本：

```bash
node -p "require('${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json').version"
```

然后刷新核心产物：

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/bridge_skills.sh"
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install_dispatchers.sh"
bash "${CLAUDE_PLUGIN_ROOT}/scripts/mcp_codex.sh"
bash "${CLAUDE_PLUGIN_ROOT}/scripts/mcp_claude.sh"
bash "${CLAUDE_PLUGIN_ROOT}/scripts/bridge_mcp.sh"
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bridge_hooks.py"
```

对锁定的 `claude-octopus` 做真实 MCP initialize 握手：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/boot_test_claude_mcp.mjs"
```

最后运行 `scripts/status.sh`。握手或核心状态失败时原样报告并停止；全部成功时提醒
用户分别新开 Claude 与 Codex 对话。不要恢复旧的 implement/audit/plan 入口。
