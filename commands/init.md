---
description: 在当前项目安装 Claude ↔ Codex 的单入口键盘派遣器
allowed-tools:
  - Bash
---

# cc-suite 初始化

本版本只提供两个显式入口：

- Claude：只输入 `/codex` 并回车，在模型调用前用键盘选择配置；然后发送任务。
- Codex：只输入 `$claude` 并回车，在模型调用前用键盘选择配置；然后发送任务。

不要生成编号配置候选，不要在消息发出后询问配置，也不要生成
implement、review、plan、audit 或 debug 分类。

1. 检查 `node`、`codex` 和 `claude` 均可用；缺失时明确报错并停止。
2. 运行：

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-projects.mjs" sync \
     --scope "$PWD" --project "$PWD" --source "${CLAUDE_PLUGIN_ROOT}"
   ```

3. 若成功，只报告：

   ```text
   cc-suite 已为当前项目安装单入口键盘派遣器。
   Claude：输入 /codex 并回车 → 选配置 → 发送任务
   Codex：输入 $claude 并回车 → 选配置 → 发送任务
   每次新任务或追问都要重新输入目标前缀。
   ```

若失败，显示原始错误并停止；不得声称已安装，也不得改用宿主模型代答。
