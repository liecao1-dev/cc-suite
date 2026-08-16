---
description: 在当前项目安装 Claude ↔ Codex 的发送前配置候选
allowed-tools:
  - Bash
---

# cc-suite 初始化

本版本只提供两组前缀候选：

- Claude：输入 `/codex`，先选配置，在同一输入框追加任务，再发送一次。
- Codex：输入 `$claude`，先选配置，在同一输入框追加任务，再发送一次。

不要创建 exact `/codex` 命令，不要在消息发出后询问编号，也不要生成
implement、review、plan、audit 或 debug 分类。

1. 检查 `node`、`codex` 和 `claude` 均可用；缺失时明确报错并停止。
2. 运行：

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-projects.mjs" sync \
     --scope "$PWD" --project "$PWD" --source "${CLAUDE_PLUGIN_ROOT}"
   ```

3. 若成功，只报告：

   ```text
   cc-suite 已为当前项目安装发送前配置候选。
   Claude：输入 /codex → 选配置 → 追加任务 → 发送
   Codex：输入 $claude → 选配置 → 追加任务 → 发送
   每次新任务或追问都要重新输入目标前缀。
   ```

若失败，显示原始错误并停止；不得声称已安装，也不得改用宿主模型代答。
