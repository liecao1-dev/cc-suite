# cc-suite simple dispatch

cc-suite 3 把 Claude Code 与 Codex 之间的协作收成两个入口：

```text
# 在 Claude Code 里
/codex 帮我找出登录流程偶尔卡住的原因

# 在 Codex 里
输入 $claude → 在候选菜单选 Claude 配置 → 继续写任务 → 回车一次
```

任务直接用大白话写。没有 `implement`、`audit`、`review-plan`、
`claude-debug` 之类的任务分类。

## 核心规则

每次派遣都让用户手动选择完整配置，顺序统一为：

1. 最近一次用过的配置；
2. 默认配置；
3. 其他当前可用模型。

“最近配置”是上一次选择的 `模型 + 推理强度 + 权限`，不是最近发布的模型。
Claude → Codex 在发送命令后弹出选择；Codex → Claude 则在输入框里先显示 5 个
配置候选，选好后才发送。后者为了保持菜单位置固定，会始终保留“最近”和
“默认”两个入口；项目第一次没有最近记录时，“最近”入口明确采用默认配置。

路由是非黏性的：完成一次任务后，下一次任务或追问仍要重新写 `/codex` 或
重新输入 `$claude` 并选择配置。

目标模型不可用时会明确失败，不会让当前模型冒充目标模型代答。

## 两个方向

### Claude → Codex

日常写法：

```text
/codex <任务>
```

初始化会生成项目级 `.claude/commands/codex.md`，因此可以使用字面量
`/codex`。如果项目原本已有同名命令，cc-suite 不会覆盖它；改用插件自带的
`/cc-suite:codex` 即可。

模型列表来自当前 Codex CLI 的实时本地 catalog。派遣通过
`scripts/codex-runner.mjs` 调用 `codex exec`，有 15 分钟 deadline、job 记录
和可终止进程，不会无限等待。

配置字段：

- `model`：当前 Codex catalog 中的模型；
- `effort`：所选模型实际支持的推理强度；
- `sandbox`：`read-only`、`workspace-write` 或 `danger-full-access`。

### Codex → Claude

日常操作只发送一次：

```text
1. 在输入框键入 $claude（先不要发送）
2. 选择 Claude 1｜最近配置、Claude 2｜默认配置、Sonnet、Opus 或 Haiku
3. 在选中的 skill 后面继续写任务，然后回车发送
```

`$claude` 是 5 个显式 Codex skill 的共同搜索前缀，不会被自然语言隐式触发。
选择配置发生在消息发送前；发送后直接通过项目锁定的 `claude-octopus` MCP
服务调用 Claude Code，不再打印编号列表，也不要求再回复一次。若只选 skill
而没写任务就发送，才会询问缺少的任务。

初始化会建立真实的 `.agents/skills/` 扫描目录，并把 5 个配置 skill 直接暴露
为 `.agents/skills/claude-*`。编号用于稳定保持“最近、默认、其他模型”的顺序：

- `Claude 1｜派遣｜最近配置`：上次的完整 `model + effort + permissionMode`；
  本项目第一次使用时明确采用默认配置；
- `Claude 2｜派遣｜默认配置`：`default · medium · permission=default`；
- `Claude 3｜派遣｜Sonnet`：`sonnet · medium · permission=default`；
- `Claude 4｜派遣｜Opus`：`opus · medium · permission=default`；
- `Claude 5｜派遣｜Haiku`：`haiku · medium · permission=default`。

若本机还安装了全局 `$claude-workflow-sync`，输入 `$claude` 时 Codex 会同时
显示上述 5 个 `Claude …｜派遣｜…` 入口与 `Claude 工作流同步`。两类名称明确
区分：前者派遣任务，后者同步 Claude Desktop 对话。

配置字段：

- `model`：`default`、`sonnet`、`opus`、`haiku`，也接受 MCP 支持的完整模型 id；
- `effort`：`low`、`medium`、`high`、`max`；
- `permissionMode`：`default`、`acceptEdits`、`plan`。

## 安装与初始化

前置条件：

- Claude Code 2.x；
- Codex CLI；
- Node.js 18.18+；
- Python 3。

从 xiaolai marketplace 安装发布版：

```bash
claude plugin marketplace add xiaolai/claude-plugin-marketplace
claude plugin install cc-suite@xiaolai --scope project
```

在目标项目的 Claude Code 对话中运行：

```text
/cc-suite:init
```

初始化只建立 Claude ↔ Codex，不在安装阶段替用户锁定模型。完成后分别新开一个
Claude 与 Codex 对话，让 `/codex` 和 `$claude` 被重新扫描。

本地开发版可以让 Claude Code 直接加载本仓库：

```bash
claude --plugin-dir /absolute/path/to/cc-suite
```

## 可见命令

日常只有 `/codex` 和 `$claude` 两个模型名入口；`$claude` 的配置作为发送前候选
显示。另保留少量维护命令：

| 入口 | 用途 |
|---|---|
| `/codex <任务>` | 派遣给 Codex |
| 输入 `$claude`，选配置后追加任务 | 发送一次，直接派遣给 Claude |
| `/cc-suite:init` | 初始化双向通道 |
| `/cc-suite:status` | 查看桥接和 job 状态 |
| `/cc-suite:diagnose` | 诊断配置问题 |
| `/cc-suite:repair` | 幂等修复桥接 |
| `/cc-suite:cancel` | 取消运行中的 Codex job |
| `/cc-suite:result` | 读取已完成 job |
| `/cc-suite:update` | 更新桥接产物 |
| `/cc-suite:unbridge` | 安全移除 cc-suite 管理的产物 |

旧的任务型入口已经移除。低层 bridge 和旧后端代码暂时保留为内部兼容能力，
不出现在日常命令面板中；新增其他模型时应沿用 `/模型名 <任务>` 的同一契约。

## 状态与安全

最近配置按项目保存在 `.cc-suite/runtime/`，目录权限由状态层收紧，并由
cc-suite 的 gitignore 区块忽略。它不包含任务正文。

生成的 `.claude/commands/codex.md` 带内容哈希：

- 重跑初始化可以安全刷新未修改的生成文件；
- 用户编辑过后，安装和卸载都不会覆盖或删除它；
- 若一开始就是用户文件，cc-suite 会保留它。

所有跨模型调用都带防回派边界，避免 Codex 收到 Claude 的任务后又调用
`$claude` 把任务交回原作者。

## 开发验证

```bash
npm test
bash tests/integration.sh
```

5 个配置 skill 还应分别通过：

```bash
for skill in skills/cc-suite/claude-*; do
  python3 <skill-creator-dir>/scripts/quick_validate.py "$skill"
done
```
