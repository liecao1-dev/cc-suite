# cc-suite simple dispatch

cc-suite 只保留 Claude Code 与 Codex 的双向派遣，不再要求先选
implement、review、plan、audit 或 debug 工作流。

## 日常怎么用

在 Claude Code 输入框里：

```text
输入 /codex，让补全菜单高亮 `/codex` 派遣入口
→ 按 Enter 或 Tab 只是选择派遣，不会发送消息
→ 本地键盘选择器立即打开，选完模型、推理强度和权限
→ 输入框内出现受保护的“Codex + 对应配置”前缀，光标紧随其后
→ 紧接着写真正的任务并发送一次
→ 发送即按刚才的配置开始派遣
```

在 Codex 输入框里：

```text
输入 $claude，让补全菜单高亮“Claude · 派遣”
→ 按 Enter 或 Tab 只是选择派遣，不会发送消息
→ 本地键盘选择器立即打开，选完模型、推理强度和权限
→ 输入框内出现受保护的“Claude + 对应配置”前缀，光标紧随其后
→ 紧接着写真正的任务并发送一次
→ 发送即按刚才的配置开始派遣
```

新版 Codex CLI 可能把补全后的同一入口显示成 `$cc-suite:claude`。cc-suite 会把这个
插件限定名称与 `$claude` 当作同一个本地选择动作：两者都会先打开配置，均不会作为
消息发送。日常仍可直接输入较短的 `$claude`。

这里没有“触发消息”：`$claude` 和 `/codex` 都是发送前的本地选择动作。代理会在
Enter/Tab 到达宿主 CLI 前吃掉按键并打开配置；选择配置期间不会调用任何模型。
选完后，代理把目标与完整配置作为受保护前缀显示在输入框内，同时单独跟踪你随后
输入的真实任务。按 Enter 时，代理先清空可见前缀，再只重放并提交任务正文，所以
前缀不会混进 Hook、上下文或目标模型。发送后前缀随一次性配置一起消失。取消配置
则什么都不发送、也不保留配置。每个新任务和追问都要重新选择目标；路由不黏住
上一轮。其他 slash command 或 skill 会暂时隐藏前缀并保留已选配置。

真正派遣前，仍处在当前对话里的宿主模型会把相关的用户/助手讨论、已经形成的决定、
引用和未解决问题整理成自洽上下文，并把当前用户原文明确附在末尾；它不会复制隐藏的
系统/开发者指令、权限信息、凭据、原始工具记录或无关历史。这样“你怎么看上面的讨论”
或“真的吗”之类的追问不会只剩一句失去指代的文本。

同一宿主会话再次选择相同目标和完全相同的配置时，cc-suite 还会续接绑定的目标对话：
Codex 使用原生 session resume；Claude 会把范围中央状态中保存的前几轮目标输入与输出作为明确的
先前对话交回同一个所选配置，因此不依赖当前 Claude print 进程是否仍然存活。
配置发生变化时开启新的目标对话，但宿主仍会传递当前任务所需的相关讨论。配置选择依然
是一次性的：每条新任务或追问都必须重新选择 `$claude` 或 `/codex`。

## 工作流自动调用：同一个统一入口

上面的“每次重新选择”针对你在输入框里发起的手动派遣。已经由 cc-suite 启动、并正在
执行任务的宿主模型，可以用目标 CLI 的普通非交互命令自动调用另一个模型：Codex 内调用
`claude -p`／`claude --print`，Claude 内调用 `codex exec`。这种自动调用不打开选择器；
命令里明确指定的配置（或目标 CLI 当前有效默认配置）就是本次一次性配置。

它不是另开一条容易失效的后门。CLI shim 会把这两种调用送入与手动派遣相同的固定代理、
一次性 ticket、runner、登录刷新、目标沙箱、上下文续接和 60 分钟截止路径。代理在启动时
固定真实宿主、会话、workspace 和唯一允许的相反目标，所以宿主进程改环境变量也不能把它
变成任意模型或任意命令服务。参数只支持普通文字推理所需的安全子集；JSON 流、任意命令、
危险权限和无法等价保持的选项会明确失败。

每次自动调用都有稳定 request id、完整 prompt 指纹和 conversation id。同一 id 与相同内容
重试只读取原状态或原结果，不会再跑一次模型；同一目标对话已有任务在运行时直接报告忙，
不暗中排队。执行器最多运行 60 分钟，收尾状态另留 30 秒；超过后记为不可重跑的 stalled，
避免一次未知完成、一次又被重复执行。需要从外层工作流重试同一个兼容调用时，保留并复用
同一 `CC_SUITE_REQUEST_ID`。

自动调用直接把目标模型的原始文字写回调用进程，不触发手动 Codex 聊天界面的
`回答来自Claude。` Stop 校验；那条固定归属行仍只属于手动 Codex → Claude 转发。

模型菜单保持精简，顺序固定为：

1. 最近配置：当前 workspace 上一次真正启动的完整配置；
2. 默认配置：当前目标 CLI 与项目配置共同解析出的有效默认值；
3. 其他当前可用模型。

“最近”不是最新发布的模型。项目第一次还没有最近记录时，第一个候选会明确使用
默认配置，但仍与第二个“默认配置”分开显示。最近行会显示时间；最近与默认两行都
显示确切的模型、推理强度、权限以及来源。Codex 还会显示审批策略。

在模型行按 Enter 进入配置：`↑/↓` 选择字段，`←/→` 切换该模型实际支持的值，
Enter 确认，Esc 返回。Codex 的推理强度逐模型读取当前 `~/.codex/models_cache.json`；
Claude Code 目前只公布全局推理与权限规则，因此从当前 `claude --help` 动态读取并
用于各 Claude 模型。Claude 的完整模型 ID 可从“其他 Claude 模型 ID…”输入。
Claude CLI 的短别名（例如 `opus`）会指向当前最新的同系列模型，并不固定版本；
需要锁定 Claude Opus 4.6 时，请在该高级行输入 `claude-opus-4-6`。
`danger-full-access` 与 `bypassPermissions` 必须再次按 Enter 双确认。

如果本机还有 `$claude-workflow-sync`，输入 `$claude` 会同时看到
“Claude · 派遣”和“Claude 工作流同步”。用 `↑/↓` 高亮后再按 Enter：选前者才打开
派遣配置，选后者仍按它自己的方式同步 Claude Desktop 对话，不会被误拦截。

## 为什么项目只保留发现入口

Codex 与 Claude 都只会从启动目录向上扫描到当前 Git 仓库根目录。放在共同父目录
的 skill 无法越过独立子仓库的边界。因此 cc-suite 保留一份中央实现，并在每个
实际项目根只生成两个很小的本地发现入口：

- `.agents/skills/claude`：Codex 里的 exact `$claude` 发现入口；
- `.claude/skills/codex`：Claude 里的 exact `/codex` 后备发现入口；

cc-suite 不再向项目复制 hook，也不再创建 `.cc-suite/project.json` 或项目级
`.cc-suite/runtime/`。双向 hook 各自在用户配置中合并一次：Codex 使用
`~/.codex/hooks.json`，Claude 使用 `~/.claude/settings.json`。两者都只指向
`/Users/charliefolder/projects/.cc-suite/bin/cc-suite-dispatch-hook` 这个稳定启动器；
脚本更新只替换启动器内容，不改变 hook 定义。

pending、一次性 ticket、最近配置、目标对话、逐字转发校验和 job 状态统一保存在
`/Users/charliefolder/projects/.cc-suite/runtime/`，内部仍按 workspace 隔离。
范围内的宿主 CLI 只额外获得这个集中 runtime 目录的写权限，让一次性执行器能够领取
ticket 并更新状态；不会因此获得其他项目或范围外目录的额外写权限。

Git 仓库使用 `.git/info/exclude` 的 cc-suite 区块忽略这些本地产物，不改共享
`.gitignore`。用户已有的 `.agents`、`.claude`、skill、command 和配置不会被
覆盖；同名冲突会被保留并报告。

用户级 hook 虽然会被 CLI 发现，但启动器会先做规范路径范围检查：当前目录不在
`/Users/charliefolder/projects` 时立即静默退出，不写状态、不阻止或改变消息；在范围内
但没有先选择 `$claude`／`/codex` 时同样只读检查后立即退出。发送前交互由
范围内的 `.cc-suite/bin/codex` 与 `.cc-suite/bin/claude` 轻量代理完成。交互模式负责
选择器；顶层非交互推理在原 CLI 外维持当前会话的固定代理；该宿主内部对相反模型的
非交互调用才进入统一程序化入口。其他目录、非推理脚本调用和版本检查都直接转给原 CLI。
Codex 只需首次审查并信任这条用户级 hook；之后新增项目、worktree 或更新 cc-suite
脚本都不会产生新的 hook 路径或定义哈希。

选择 `$claude` 前会只读检查现有 Claude 登录。access token 即使已经到期，只要当前登录
仍有 Claude CLI 原生刷新所需的材料且未到绝对期限，就允许配置生效；随后本来就要执行的
真实 Claude 推理调用自行完成刷新。`auth status --json` 只报告登录状态，不承担刷新。
cc-suite 不读取 token 内容、不交换 token，也不写入钥匙串。
顶层范围内 `claude -p` 或 `claude --print` 的原参数、当前目录、标准输入和标准输出仍交给
真实 Claude CLI，同时为它可能发起的反向 Codex 调用维持固定代理。Codex 宿主内部发起的
同名 Claude 推理则由统一入口执行，经过同一只读认证门禁和 Claude runner。范围外调用
以及 `--version` 等不启动推理的非交互命令仍立即旁路。

默认同步范围为 `/Users/charliefolder/projects`。如果 Codex 状态栏显示 `~`，当前会话
在范围外，代理会按设计旁路；先进入该范围内的具体项目再启动 Codex，或用 Codex 的
`-C` 指向该项目。范围外的 hook 会按设计静默旁路。

Codex 首次发现这条用户级命令 hook 时会显示 `Hooks need review`。
先选 `Review hooks` 核对命令指向范围内固定的 `cc-suite-dispatch-hook`，再在详情页
按 `t` 只信任该条 cc-suite hook，无需信任其他 hook。不要选
`Continue without trusting`：composer 代理会吃掉 `$claude` 并明确报错，不会打开配置或
让 Codex 冒充 Claude 回答。Codex 按 hook 定义的 hash 记住信任；定义不会随 cc-suite
源码更新变化，因此正常更新后无需重新信任。可随时用 `/hooks` 复查或撤销。

Codex 派遣直接调用已登录的 `codex` CLI；Claude 派遣直接调用 composer activation
绑定的当前 Claude CLI，并复用完全相同的 Claude Code 登录与自动刷新能力。每个 shim
启动时都会重新解析当前 CLI；包管理器更新后即使可执行文件移动，也不依赖安装时的旧路径。
两者都不要求
在每个仓库写 `.codex/config.toml` 或安装项目级 Claude MCP。两个 runner 都有 60 分钟
硬截止、job 记录和禁止把任务派回原模型的边界。后端缺失、未认证或失败时会明确停止，
当前模型不会冒充目标模型回答。Claude runner 读取当前 CLI 的结构化结果和 session ID，
再由范围中央保存、按 workspace 隔离的有界 transcript 续接下一次相同配置的派遣。

选择 `$claude` 后、打开配置菜单前，composer 代理会在 Codex 工具沙盒之外只读检查 Claude
钥匙串登录。代理不会交换或写回订阅 refresh token：这种令牌会旋转，cc-suite 若独立刷新，
可能与已经运行的 Claude 会话互相作废凭据。真正发送任务时，composer activation 绑定的当前
Claude CLI 是唯一刷新所有者，按自身版本的原生机制读取并更新钥匙串。预检查只在登录缺少
自动刷新所需材料或 refresh token 已到绝对有效期时拒绝启用配置；令牌不会写入项目、日志或
派遣状态。

runner 仍保留最后一道安全保护：只有结构化结果同时证明本次调用的输入、输出、缓存 token、
费用和模型执行记录全部为零时，才会重新启动同一个当前 Claude CLI 一次。若任务已经产生
任何模型工作则绝不重试，避免重复执行编辑；第二次仍失败时会明确停止。

手动 Codex → Claude 派遣成功后，Claude CLI 的 `result` 会原样保存，不裁掉首尾空白，
也不经过 Codex 总结。Codex 必须逐字符输出该 `rawOutput`，然后在下一行固定添加
`回答来自Claude。`；不能附加配置、jobId、标题、引号、代码围栏或其他提醒。用户级且
范围受限的 Codex `Stop` hook 会逐字比较“不变的 Claude 原文 + 固定归属行”，缺字、改字、漏加或重复
归属行都会阻止本轮结束并要求重新输出。只有匹配成功才消费这次校验。

`$claude` 派遣会从稳定启动器传入的环境读取同步范围：该范围
（例如 `/Users/charliefolder/projects`）只作为读取目录加入，写入范围则每次动态绑定到
本次启动命中的 workspace。后台 Claude 使用 fail-closed 沙盒和 `dontAsk` 白名单权限；
沙盒内的 `Bash` 及子进程只能写当前 workspace，不能切换为非沙盒命令，内置文件工具也
只对白名单 workspace 放行编辑。`WebSearch`、`WebFetch` 与 Klode 的只读 MCP 工具会
预先批准，其他未批准工具在无交互派遣中直接拒绝。用户、项目与 local settings source
不会被后台调用加载，避免旧权限规则扩大这条边界；runner 只从现有
`~/.claude.json` 读取并显式转交 `mcpServers.klode`，不会把其他 MCP 注册带入后台调用。

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

第一次还要启用一次发送前代理：

```bash
node /Users/charliefolder/projects/vibecoding/cc-suite/scripts/activate-composer.mjs install \
  --scope /Users/charliefolder/projects
```

它会在 `/Users/charliefolder/projects/.cc-suite/bin/` 生成两个可审计的 CLI shim、一个
稳定 hook 启动器和一个指向严格兼容适配器的稳定 `cc-suite-dispatch` 启动器，在
`~/.zshrc` 增加带 cc-suite 起止标记的 PATH 区块，并以保留其他
内容的方式合并用户级 Codex/Claude hook。它不会替换真实 `codex` 或 `claude`。安装后新开一个终端，再从
`/Users/charliefolder/projects` 的任意层级子项目启动 CLI；不要求启动目录正好等于
scope 根目录。只重启 Codex/Claude CLI、不重启安装前已经打开的 shell 不够；这种
情况下先在那个 shell 执行 `source ~/.zshrc`。

也可以让 shell 留在其他目录，使用 Codex 官方的工作目录参数启动 scope 内项目；
代理会按 `-C/--cd` 指定的有效目录判定，而不是误用 shell 当前目录：

```bash
codex -C /Users/charliefolder/projects/Writing-workflow/智慧鉴赏/围炉文稿工作流
```

检查或完全撤销这层启用：

```bash
node /Users/charliefolder/projects/vibecoding/cc-suite/scripts/activate-composer.mjs status \
  --scope /Users/charliefolder/projects

node /Users/charliefolder/projects/vibecoding/cc-suite/scripts/activate-composer.mjs remove \
  --scope /Users/charliefolder/projects
```

发现器会处理普通 Git 仓库、嵌套仓库和 worktree，并排除 `.git`、隐藏运行时目录、
`node_modules`、`dist`、`build`、缓存和依赖目录。非 Git 项目会按常见项目标记识别。

同步会在范围内生成便捷命令：

```bash
/Users/charliefolder/projects/.cc-suite/bin/cc-suite-projects sync
```

新建、clone 或者没有常见项目标记的非 Git 工作目录，在 scope 内首次交互式启动
Codex/Claude CLI 时，composer 代理会先幂等补齐当前项目入口。上面的命令仍可用于
提前同步整个 scope 或修复已有入口；不需要 watcher，也不需要每个项目重复安装 hook。

查看发现结果和状态：

```bash
/Users/charliefolder/projects/.cc-suite/bin/cc-suite-projects list
/Users/charliefolder/projects/.cc-suite/bin/cc-suite-projects status
```

安全移除范围内由 cc-suite 管理的项目入口、用户级 hook 与集中状态：

```bash
/Users/charliefolder/projects/.cc-suite/bin/cc-suite-projects remove
```

项目移除只删除校验为 cc-suite 所有的文件、目录、链接、旧版标准 MCP 注册和本地
exclude 区块；用户内容保留。若还要删除 shell PATH 区块和两个 composer shim，再
运行上面的 `activate-composer.mjs remove`。同步本身就是 repair，重复执行不会产生
新的差异。

## 单个项目与插件维护命令

Claude 插件仍提供少量维护入口：

| 入口 | 用途 |
|---|---|
| `/cc-suite:init` | 为当前项目安装双向键盘派遣器 |
| `/cc-suite:repair` | 幂等刷新当前项目入口与稳定用户级 hooks |
| `/cc-suite:status` | 查看入口和 job 状态 |
| `/cc-suite:diagnose` | 结构化诊断 |
| `/cc-suite:cancel` | 取消运行中的 job |
| `/cc-suite:result` | 读取已完成 job |
| `/cc-suite:update` | 更新后刷新当前项目 |
| `/cc-suite:unbridge` | 安全移除当前项目的管理产物 |

没有任务分类命令，也没有“先发送 `$claude`／`/codex`，再回复编号”的流程。Exact
skill 只负责补全菜单发现与代理失效提示；正常配置流程由发送前 composer 代理完成，
用户级 hook 只有在范围内真实任务提交且已有锁定配置时才会消费它。

## 开发验证

```bash
npm test
bash tests/integration.sh

python3 <skill-creator-dir>/scripts/quick_validate.py skills/cc-suite/claude
```
