---
description: 幂等修复 Claude ↔ Codex 的两个派遣入口和底层 MCP、skills、hooks 配置
---

# cc-suite repair

只修复 Claude ↔ Codex 核心通道。按顺序运行全部命令；单步失败时记录错误并继续，
最后统一报告失败项：

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/init.sh"
bash "${CLAUDE_PLUGIN_ROOT}/scripts/bridge_skills.sh"
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install_dispatchers.sh"
bash "${CLAUDE_PLUGIN_ROOT}/scripts/mcp_codex.sh"
bash "${CLAUDE_PLUGIN_ROOT}/scripts/mcp_claude.sh"
bash "${CLAUDE_PLUGIN_ROOT}/scripts/bridge_mcp.sh"
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bridge_hooks.py"
```

然后运行：

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/status.sh"
```

核心成功条件：

- `.claude/commands/codex.md` 是 cc-suite 生成的 `/codex`，或用户同名文件被保留
  且 `/cc-suite:codex` 可用；
- `.agents/skills/claude-{1..5}-*/SKILL.md` 的 5 个配置入口均可读；
- `.codex/config.toml` 含 `cc-suite-claude-mcp`；
- `codex` CLI 可用。

成功时只说“Claude ↔ Codex 派遣已修复，请新开对话重新扫描入口”。失败时逐项给出
原始错误，不要回退到旧任务型命令。
