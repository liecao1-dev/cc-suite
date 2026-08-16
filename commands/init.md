---
description: 一次完成 Claude 与 Codex 的双向派遣初始化；不设置工作流分类，也不预选模型
allowed-tools:
  - Bash
---

# cc-suite 初始化

本版本只建立两条日常入口：

- Claude 里用 `/codex <任务>` 派遣给 Codex。
- Codex 里先输入 `$claude`，在发送前选配置、追加任务，再派遣给 Claude。

模型配置不在初始化时锁定。每次派遣都从输入框候选中重新选择，并按照“最近
配置、默认配置、其他模型”的顺序排列；发送后不再要求回复编号。

## 1. 本地依赖检查

运行：

```bash
command -v node
command -v python3
command -v codex
```

若 `node` 或 `python3` 缺失，说明缺失项并停止。若 `codex` 缺失，提示安装
`@openai/codex` 后停止。这里不发起模型请求；认证与实时模型目录由每次
`/codex` 的 preflight 检查。

## 2. 建立共享项目层

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/init.sh"
```

该脚本会安全地：

- 以 `AGENTS.md` 作为共享项目说明，并让 `CLAUDE.md` 导入它；
- 暴露 cc-suite skills 给 Codex；
- 生成由 cc-suite 管理的 `.claude/commands/codex.md`，从而提供字面量
  `/codex`。若项目已有用户自己的同名文件，脚本不会覆盖；此时仍可用
  `/cc-suite:codex`。

若脚本失败，显示错误并停止。

## 3. 建立双向调用通道

按顺序执行：

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/mcp_codex.sh"
bash "${CLAUDE_PLUGIN_ROOT}/scripts/mcp_claude.sh"
bash "${CLAUDE_PLUGIN_ROOT}/scripts/bridge_mcp.sh"
```

- `mcp_codex.sh` 保留 Claude 侧的标准 Codex MCP 能力；日常 `/codex` 仍走
  可超时、可终止、可记录 job 的 CLI runner。
- `mcp_claude.sh` 把锁定版本的 `claude-octopus` 注册到
  `.codex/config.toml`，供 `$claude` 使用。
- `bridge_mcp.sh` 让两边看到相同的项目 MCP 服务。

任一步失败都显示具体脚本和错误，不要掩盖失败，也不要宣称初始化成功。

## 4. 可选地同步现有 hooks

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bridge_hooks.py"
```

没有 `.claude/settings.json` hooks 时允许安全跳过。

## 5. 验证

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/status.sh"
```

另外确认：

```bash
grep -q '^<!-- cc-suite-dispatcher: codex sha256=' .claude/commands/codex.md
for skill in claude-1-recent claude-2-default claude-3-sonnet claude-4-opus claude-5-haiku; do
  test -f ".agents/skills/${skill}/SKILL.md"
done
grep -q 'cc-suite-claude-mcp' .codex/config.toml
```

如果第一项失败但 `.claude/commands/codex.md` 是用户文件，明确报告“同名命令已
保留，可使用 `/cc-suite:codex`”，这不是数据损坏。其余核心检查失败则初始化
未完成。

## 6. 返回简短结果

只报告以下内容：

```text
cc-suite 已完成 Claude ↔ Codex 初始化。

Claude：/codex <用大白话写任务>
Codex：输入 $claude → 选配置 → 追加大白话任务 → 回车

每次都会重新选配置；发送后不再回复编号。
请分别新开一个 Claude 与 Codex 对话，让新命令和 skill 被重新扫描。
```

不要再推荐 `/implement`、`/audit`、`$claude-plan` 等旧任务型入口。
