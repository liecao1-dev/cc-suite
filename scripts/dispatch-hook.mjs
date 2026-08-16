#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describeDispatchConfig } from "./lib/dispatch-config.mjs";
import { readHookInput } from "./lib/hook-input.mjs";
import {
  ticketForSubmittedPrompt,
} from "./lib/dispatch-state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXECUTOR = path.join(ROOT, "scripts", "dispatch-execute.mjs");

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || !["--host", "--target"].includes(key)) {
      throw new Error("usage: dispatch-hook.mjs --host <codex|claude> --target <claude|codex>");
    }
    values[key.slice(2)] = value;
  }
  if (!/^(codex|claude)$/.test(values.host) || !/^(codex|claude)$/.test(values.target)) {
    throw new Error("invalid host or target");
  }
  if (values.host === values.target) throw new Error("host and target must differ");
  return values;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function block(reason) {
  return { decision: "block", reason };
}

function triggerFor(host, input) {
  if (host === "codex") {
    return input.hook_event_name === "UserPromptSubmit"
      && /^\$claude(?:\s|$)/i.test(String(input.prompt ?? "").trim());
  }
  return input.hook_event_name === "UserPromptExpansion"
    && input.expansion_type === "slash_command"
    && input.command_name === "codex";
}

export function effectiveDispatchSessionId(host, input, env = process.env) {
  const composerSession = String(env.CC_SUITE_COMPOSER_SESSION ?? "");
  if (
    env.CC_SUITE_COMPOSER_HOST === host
    && /^[a-f0-9]{32}$/i.test(composerSession)
  ) return composerSession;
  return typeof input.session_id === "string" ? input.session_id : "";
}

function dispatchContext(ticket) {
  const config = describeDispatchConfig(ticket.target, ticket.config);
  const target = ticket.target === "codex" ? "Codex" : "Claude";
  return [
    "[cc-suite one-shot dispatch ticket]",
    `The user explicitly selected ${target} before submitting the current task.`,
    "Do not answer, solve, rewrite, classify, or delegate the task anywhere else.",
    `Run the current user prompt verbatim through this exact one-shot executor from the current working directory:`,
    `node ${JSON.stringify(EXECUTOR)} --ticket ${JSON.stringify(ticket.token)} --prompt-stdin`,
    "Pass the full current user prompt through stdin, never through a shell argument. Do not add or remove task text.",
    `Locked target configuration: ${config}`,
    "The executor validates and consumes the ticket, launches the target CLI, and returns one JSON object.",
    "If status=completed, present rawOutput faithfully, then state the exact configuration and jobId.",
    "If status=failed or stalled, report that error and stop; do not answer the task yourself and do not retry silently.",
    `End with a short reminder that before sending the next task or follow-up, the user must select ${ticket.host === "codex" ? "$claude" : "/codex"} from the composer again.`,
  ].join("\n");
}

function additionalContext(eventName, context) {
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
    },
  };
}

function dispatchScope(cwd) {
  if (process.env.CC_SUITE_COMPOSER_SCOPE) return process.env.CC_SUITE_COMPOSER_SCOPE;
  try {
    const root = resolveWorkspaceRoot(cwd);
    const marker = JSON.parse(fs.readFileSync(path.join(root, ".cc-suite", "project.json"), "utf8"));
    if (typeof marker?.scopeRoot === "string" && marker.scopeRoot) return marker.scopeRoot;
  } catch {}
  return "已配置的项目范围";
}

function handleTrigger(args, input) {
  const prefix = args.host === "claude" ? "/codex" : "$claude";
  const scope = dispatchScope(input.cwd);
  emit(block(
    `${prefix} 不应作为消息发送。当前会话没有启用 cc-suite 的发送前 composer 代理；本条内容已阻止，未调用任何模型。请确认 scope ${scope} 已运行 activate-composer.mjs install，再从新终端启动 ${args.host === "codex" ? "Codex" : "Claude"} CLI，并在补全菜单里选择 ${prefix}。`,
  ));
}

function handleSubmit(args, input) {
  if (input.hook_event_name !== "UserPromptSubmit") return;
  const sessionId = effectiveDispatchSessionId(args.host, input);
  if (!sessionId) return;
  let result;
  try {
    result = ticketForSubmittedPrompt(input.cwd, {
      host: args.host,
      sessionId,
      prompt: input.prompt,
    });
  } catch {
    return;
  }
  if (result.status === "expired") {
    emit(block(`上次派遣配置已过期。请在发送前重新选择 ${args.host === "codex" ? "$claude" : "/codex"}；本条任务未发送给任何模型。`));
  } else if (result.status === "ready") {
    emit(additionalContext(input.hook_event_name, dispatchContext(result.ticket)));
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const input = readHookInput();
  if (triggerFor(args.host, input)) handleTrigger(args, input);
  else handleSubmit(args, input);
} catch (error) {
  // A malformed invocation is a configuration defect. Stay silent so an
  // unrelated user prompt is never blocked by a broken local installation.
  process.stderr.write(`cc-suite dispatch hook: ${error.message}\n`);
}
