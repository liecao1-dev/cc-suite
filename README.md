# cc-suite simple dispatch

cc-suite 只保留 Claude Code 与 Codex 的双向派遣，不再要求先选
implement、review、plan、audit 或 debug 工作流。

## 日常怎么用

在 Claude Code 输入框里：

```text
只输入 /codex 并回车
→ 本地键盘选择器立即打开
→ 选好配置后，再发送一条大白话任务
```

在 Codex 输入框里：

```text
只输入 $claude 并回车
→ 本地键盘选择器立即打开
→ 选好配置后，再发送一条大白话任务
```

触发消息会在宿主模型调用前被项目 hook 拦住，所以不会再让模型打印编号，也不要求
回复 `1`、`2` 或 `3`。选完后的下一条普通消息才是任务。每个新任务和追问都要
重新输入目标前缀；路由不黏住上一轮。其他 slash command 或 skill 不会误吃掉已选配置。

模型菜单保持精简，顺序固定为：

1. 最近配置：本项目上一次真正启动的完整配置；
2. 默认配置：当前目标 CLI 与项目配置共同解析出的有效默认值；
3. 其他当前可用模型。

“最近”不是最新发布的模型。项目第一次还没有最近记录时，第一个候选会明确使用
默认配置，但仍与第二个“默认配置”分开显示。最近行会显示时间；最近与默认两行都
显示确切的模型、推理强度、权限以及来源。Codex 还会显示审批策略。

在模型行按 Enter 进入配置：`↑/↓` 选择字段，`←/→` 切换该模型实际支持的值，
Enter 确认，Esc 返回。Codex 的推理强度逐模型读取当前 `~/.codex/models_cache.json`；
Claude Code 目前只公布全局推理与权限规则，因此从当前 `claude --help` 动态读取并
用于各 Claude 模型。Claude 的完整模型 ID 可从“其他 Claude 模型 ID…”输入。
`danger-full-access` 与 `bypassPermissions` 必须再次按 Enter 双确认。

如果本机还有 `$claude-workflow-sync`，输入 `$claude` 会同时看到
“Claude｜派遣”和“Claude 工作流同步”。前者派遣任务，后者同步 Claude
Desktop 对话，名称不会混在一起。

## 为什么每个项目根都要有入口

Codex 与 Claude 都只会从启动目录向上扫描到当前 Git 仓库根目录。放在共同父目录
的 skill 无法越过独立子仓库的边界。因此 cc-suite 保留一份中央实现，并在每个
实际项目根生成很小的本地入口：

- `.agents/skills/claude`：Codex 里的 exact `$claude` 发现入口；
- `.claude/skills/codex`：Claude 里的 exact `/codex` 后备发现入口；
- `.codex/hooks.json`：只追加 cc-suite 的 Codex `UserPromptSubmit` handler；
- `.claude/settings.local.json`：只追加 cc-suite 的 Claude 派遣 handlers；
- `.cc-suite/project.json`：项目边界与来源标记；
- `.cc-suite/runtime/`：该项目自己的 pending、一次性 ticket、最近配置与 job 状态。

Git 仓库使用 `.git/info/exclude` 的 cc-suite 区块忽略这些本地产物，不改共享
`.gitignore`。用户已有的 `.agents`、`.claude`、skill、command 和配置不会被
覆盖；同名冲突会被保留并报告。

hooks 只安装在显式同步的项目范围内，不写 `~/.codex` 或 `~/.claude`。首次在项目
中使用时，Codex 或 Claude Code 仍可能要求信任该项目；未信任时选择器不会运行，
后备 skill 会明确提示修复，不会让宿主模型冒充目标模型。

普通派遣直接调用已登录的 `codex` 或 `claude` CLI，所以不需要在每个仓库写
`.codex/config.toml` 或安装项目级 Claude MCP。两个 runner 都有 15 分钟硬截止、
job 记录和禁止把任务派回原模型的边界。后端缺失、未认证或失败时会明确停止，
当前模型不会冒充目标模型回答。

同步时还会移除旧版 cc-suite 的标准 `codex-cli` MCP 注册和带 cc-suite 标记的
Claude MCP 区块，避免首次启动继续弹出已废弃的 MCP 确认。自定义 `codex-cli`
条目、其他 MCP server 和用户配置都会保留并报告。

## 同步一个 projects 范围

例如中央源码位于：

```text
/Users/charliefolder/projects/vibecoding/cc-suite
```

同步 `/Users/charliefolder/projects` 下已有项目：

```bash
node /Users/charliefolder/projects/vibecoding/cc-suite/scripts/sync-projects.mjs sync \
  --scope /Users/charliefolder/projects
```

发现器会处理普通 Git 仓库、嵌套仓库和 worktree，并排除 `.git`、隐藏运行时目录、
`node_modules`、`dist`、`build`、缓存和依赖目录。非 Git 项目会按常见项目标记识别。

同步会在范围内生成便捷命令：

```bash
/Users/charliefolder/projects/.cc-suite/bin/cc-suite-projects sync
```

以后新建或 clone 项目后运行一次这个命令即可补齐入口。若严格禁止在
`/Users/charliefolder/projects` 之外写全局 hook、启动器或 watcher，就无法在未来
未知仓库创建的瞬间自动获知它；这个幂等同步命令是该限制下最安全的做法。

查看发现结果和状态：

```bash
/Users/charliefolder/projects/.cc-suite/bin/cc-suite-projects list
/Users/charliefolder/projects/.cc-suite/bin/cc-suite-projects status
```

安全移除范围内由 cc-suite 管理的入口与最近配置：

```bash
/Users/charliefolder/projects/.cc-suite/bin/cc-suite-projects remove
```

移除只删除校验为 cc-suite 所有的文件、目录、链接、旧版标准 MCP 注册和本地
exclude 区块；用户内容保留。同步本身就是 repair，重复执行不会产生新的差异。

## 单个项目与插件维护命令

Claude 插件仍提供少量维护入口：

| 入口 | 用途 |
|---|---|
| `/cc-suite:init` | 为当前项目安装双向键盘派遣器 |
| `/cc-suite:repair` | 幂等刷新当前项目入口与 hooks |
| `/cc-suite:status` | 查看入口和 job 状态 |
| `/cc-suite:diagnose` | 结构化诊断 |
| `/cc-suite:cancel` | 取消运行中的 job |
| `/cc-suite:result` | 读取已完成 job |
| `/cc-suite:update` | 更新后刷新当前项目 |
| `/cc-suite:unbridge` | 安全移除当前项目的管理产物 |

没有任务分类命令，也没有“发出任务后再回复编号”的配置流程。Exact `/codex`
skill 只负责发现与失效提示；正常选择流程由模型调用前的项目 hook 完成。

## 开发验证

```bash
npm test
bash tests/integration.sh

python3 <skill-creator-dir>/scripts/quick_validate.py skills/cc-suite/claude
```
