#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describeDispatchConfig } from "./lib/dispatch-config.mjs";
import { readHookInput } from "./lib/hook-input.mjs";
import {
  clearPendingDispatch,
  savePendingDispatch,
  ticketForSubmittedPrompt,
} from "./lib/dispatch-state.mjs";
import { runDispatchPicker } from "./dispatch-picker.mjs";

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
    `End with a short reminder that the next task or follow-up must start again with ${ticket.host === "codex" ? "$claude" : "/codex"}.`,
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

function handleTrigger(args, input) {
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || !sessionId) {
    emit(block("无法识别当前会话，未打开派遣配置；没有调用模型。"));
    return;
  }
  const hasTriggerArgs = args.host === "claude"
    ? Boolean(String(input.command_args ?? "").trim())
    : !/^\$claude\s*$/i.test(String(input.prompt ?? "").trim());
  if (hasTriggerArgs) {
    const prefix = args.host === "claude" ? "/codex" : "$claude";
    emit(block(`请只输入 ${prefix} 并回车，先选模型配置；选完后再发送任务。当前内容未调用任何模型。`));
    return;
  }
  try {
    clearPendingDispatch(input.cwd, { host: args.host, sessionId });
    const selected = runDispatchPicker({ target: args.target, cwd: input.cwd });
    if (selected.cancelled) {
      emit(block("已取消派遣配置；没有调用任何模型。"));
      return;
    }
    savePendingDispatch(input.cwd, {
      host: args.host,
      target: args.target,
      sessionId,
      config: selected.config,
      catalogVersion: selected.catalogVersion,
      selectedProfile: selected.profileId,
    });
    emit(block(`已选定 ${describeDispatchConfig(args.target, selected.config)}。现在直接发送本次任务；该配置只使用一次。没有调用模型。`));
  } catch (error) {
    emit(block(`派遣配置未完成：${error.message}。没有调用模型。`));
  }
}

function handleSubmit(args, input) {
  if (input.hook_event_name !== "UserPromptSubmit") return;
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || !sessionId) return;
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
    emit(block(`上次派遣配置已过期。请重新输入 ${args.host === "codex" ? "$claude" : "/codex"} 选择配置；本条任务未发送给任何模型。`));
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
