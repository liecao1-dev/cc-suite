# cc-suite simple dispatch

cc-suite 3 把 Claude Code 与 Codex 之间的协作收成两个入口：

```text
# 在 Claude Code 里
/codex 帮我找出登录流程偶尔卡住的原因

# 在 Codex 里
$claude 帮我把这份 README 改得让新手能直接照着安装
```

任务直接用大白话写。没有 `implement`、`audit`、`review-plan`、
`claude-debug` 之类的任务分类。

## 核心规则

每次派遣都会先让用户手动选择完整配置：

1. 最近一次用过的配置；
2. 默认配置；
3. 其他当前可用模型。

“最近配置”是上一次选择的 `模型 + 推理强度 + 权限`，不是最近发布的模型。
最近与默认相同时只显示一次，并标注“最近且默认”。任何配置都不会被自动采用。

路由是非黏性的：完成一次任务后，下一次任务或追问仍要重新写 `/codex` 或
`$claude`。配置选择阶段的回答属于尚未发出的这一次任务，不需要重复前缀。

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

日常写法：

```text
$claude <任务>
```

`$claude` 是显式 Codex skill，不会被自然语言隐式触发。它通过项目锁定的
`claude-octopus` MCP 服务调用 Claude Code。

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

日常只有一个 Claude 派遣命令和一个 Codex 派遣 skill。另保留少量维护命令：

| 入口 | 用途 |
|---|---|
| `/codex <任务>` | 派遣给 Codex |
| `$claude <任务>` | 派遣给 Claude |
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

新 skill 还应通过：

```bash
python3 <skill-creator-dir>/scripts/quick_validate.py \
  skills/cc-suite/claude
```
