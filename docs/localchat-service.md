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
