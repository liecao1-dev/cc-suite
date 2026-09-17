---
description: 在当前项目安装 Claude ↔ Codex 的单入口键盘派遣器
allowed-tools:
  - Bash
---

# cc-suite 初始化

本版本只提供两个显式入口：

- Claude：在补全菜单高亮 `/codex` 并按 Enter/Tab，先选完配置；再写真正任务并发送。
- Codex：在补全菜单高亮 `$claude` 并按 Enter/Tab，先选完配置；再写真正任务并发送。

`/codex` 与 `$claude` 是发送前选择，绝不能作为消息提交。不要生成编号配置候选，
不要在消息发出后询问配置，也不要生成
implement、review、plan、audit 或 debug 分类。

1. 检查 `node`、`codex` 和 `claude` 均可用；缺失时明确报错并停止。
2. 运行：

   ```bash
   scope="${CC_SUITE_SCOPE_ROOT:-$PWD}"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-projects.mjs" sync \
     --scope "$scope" --project "$PWD" --source "${CLAUDE_PLUGIN_ROOT}"
   ```

3. 若成功，只报告：

   ```text
   cc-suite 已为当前项目安装派遣入口，并配置范围受限的稳定用户级 hooks。
   Claude：选择 /codex → 选完配置 → 写任务 → 只发送任务
   Codex：选择 $claude → 选完配置 → 写任务 → 只发送任务
   若上级项目范围尚未启用 composer 代理，还需为那个范围运行 activate-composer.mjs install，并从新终端启动 CLI。
   每次新任务或追问都要重新选择目标入口。
   ```

若失败，显示原始错误并停止；不得声称已安装，也不得改用宿主模型代答。
