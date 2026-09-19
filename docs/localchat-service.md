# Localchat M0 service client

M0 adds an opt-in, registered third caller alongside the existing Claude/Codex
composer callers. It reuses the current activation manifest, dispatch catalog,
configuration validator, native login, runners and process lifecycle helpers.
The original composer broker continues to permit only its opposite CLI.

## Local registration

```bash
node scripts/localchat-service.mjs register \
  --scope /absolute/scope --workspace /absolute/scope/authorized-subdirectory \
  --client localchat-example --credential-file /private/path/client.json
```

The credential parent must be private (0700), owned by the service user, and
outside the authorized workspace. Registration is exclusive: repeating it
never rotates a token or overwrites user-owned configuration. A deliberate new
registration uses a new client ID and a new credential path. Optional
`--presets-file` accepts a JSON array of `{id,label,backend,config}` entries.

The private registration stores the token hash and canonical workspace under
`<scope>/.cc-suite/runtime/localchat-service/<client-id>`. The client credential
is mode 0600. Never commit either file. The authorized workspace must not contain
the execution source or scope service state.

## Request protocol

`node scripts/localchat-service.mjs request --scope /absolute/scope` reads one
closed stdin JSON object, at most 128 KiB, and returns one JSON envelope:
`{ok:true,result}` or `{ok:false,error:{code,message}}`.

Required identity fields are `schema:1`, `client_id`, and `token`.
Operations are `capabilities`, `resolve`, and the local diagnostic `probe`.
Resolve/probe require `backend` and an explicit `selection` ID. Overrides accept
only `model`, `effort`, `access`, and Codex `approval`. Optional `workspace_id`
must match the registered workspace. No caller command, cwd, env or target path
is accepted. Discovery does not claim that login, quota or inference succeeded.

M0 Codex permits `read-only` / `never`; Claude permits `plan` or `dontAsk` with
only the scoped `Read` tool and no MCP forwarding. Catalog rows retain original
default values and show why incompatible rows are disabled. `analysis` and
`analysis-deep` are readonly named presets; administrator presets have IDs
`preset:<id>`. Resolving never changes recent state. Recent is client-specific
and updated only when the runner reports that a native CLI actually started.
Requested aliases are preserved; `model_resolution.reported` stays null when
the runner does not expose a concrete model ID.

A probe additionally requires a stable `request_id` and a prompt up to 32 KiB.
It is a synchronous, bounded diagnostic, not the future asynchronous Chat task
API. An exclusive durable claim prevents duplicate execution. Repeating the
same request returns its saved result, including after catalog changes; changed
request bytes fail. An interrupted claim is indeterminate and must be inspected
locally; it is never automatically rerun. Only one probe per client can run.

The runner receives a fixed readonly policy on fd 3, separate from prompt stdin.
Codex uses a private configuration home and a symlink to the existing file-based
native login; the ordinary `--sandbox` argument is omitted because it overrides
the narrower permission profile. A changed auth reference fails closed.
Keychain-only Codex login is not supported by this M0 adapter. Claude keeps its
native login/refresh, excludes settings sources and disables unrelated MCP.
Neither route forwards inherited host identity or environment API credentials.

This entry is intended for the same trusted local OS user as localchat. It is
not a general shell service or an OS-level isolation boundary for malicious
same-user processes. Private runtime logs may contain task material and remain
outside source Git. No new hook, shell PATH block, daemon, or release is installed.

Verification: `npm test` and `bash tests/integration.sh`. Localchat owns the
source hash pin, optional MCP discovery/resolve tools, and live acceptance report.


## M1 prepared asynchronous execution

Localchat now exposes persistent tasks through a detached queue worker. The
service adds `prepare` and `run`; neither is a general command interface.
`prepare` accepts an explicit configuration, stable `request_id` and a visible
context prompt of at most 64000 UTF-8 bytes, then stores the frozen tuple and
prompt privately. Identical preparation replays the same snapshot; conflicting
content is rejected. `run` accepts only backend and prepared request identity,
revalidates the frozen model/permissions against the current CLI catalog, and
never resolves a changed preset again. A removed model fails without fallback.

The existing bounded runner, native login, read-only policy and single-client
execution lock remain in force. A durable execution claim prevents duplicate
inference. Visible results are limited to 1 MiB. The service forwards a concrete
Claude model ID and permission-denial summaries when reported by the native
CLI; unknown fields stay null/empty. The Localchat worker owns persistence and
queueing, independently of HTTP/stdio request lifetime. M2 will add continuation,
cancellation and recovery of uncertain claims; M1 never restarts such claims.


## M2：绑定续接、停止和恢复

`prepare` 可传 `parent_request_id`，只允许引用同一注册客户端、相同后端的已准备任务。省略配置时继承父任务的冻结配置；显式配置会重新验证。`run` 只接受已准备的身份，不接受任意 session、路径或环境覆盖。

配置未变且父轮成功时，Codex 从所属客户端的完成记录取得 session ID，经私有策略管道绑定给运行器，使用 `codex exec resume`。运行器拒绝不匹配的 resume 参数。Claude 保持非持久 print 模式，重放已保存的后端回答；变更配置使用新会话和上下文交接。最多重放 6 轮回答、约 20 KB，报告截断信息；调用方须保留完整用户原话和持久约束。

新增 `inspect` 和 `cancel` 操作，仍要求客户端凭据、后端和准备好的 request ID。私有执行记录绑定服务进程身份，独立凭据记录原生进程与运行器的 PID/启动时间及原始完成结果。取消先保存意图，核实进程停止后确认；不将发出信号等同于停止。截止时间后的恢复优先使用已保存的原生完成凭据，避免误判为超时。

`inspect` 不发起模型请求。可确认未启动的任务返回 `not_started`，可供调用方重新排队；已接受但无可确认结果的任务保持 `indeterminate`，不会重跑。旧版没有进程身份的未完成记录需要本地检查。

此协议仍不支持编辑权限、实时插话或实时审批；权限拒绝只能按 CLI 实际提供的信息上报。所有原始结果和进程凭据位于工作区外的私有客户端目录，不回显登录凭据或完整任务上下文。
