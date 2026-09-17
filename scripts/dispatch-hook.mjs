#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describeDispatchConfig } from "./lib/dispatch-config.mjs";
import { readHookInput } from "./lib/hook-input.mjs";
import {
  ticketForSubmittedPrompt,
  verifyExactClaudeResponse,
} from "./lib/dispatch-state.mjs";
import { configuredScopeRoot, cwdIsInConfiguredScope } from "./lib/scoped-dispatch.mjs";

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
  const exactClaudeRelay = ticket.host === "codex" && ticket.target === "claude";
  const resumesConversation = ticket.target === "claude"
    ? Boolean(ticket.conversationTurns?.length)
    : Boolean(ticket.resumeThreadId);
  return [
    "[cc-suite one-shot dispatch ticket]",
    `The user explicitly selected ${target} before submitting the current task.`,
    "Do not answer, solve, rewrite, classify, or delegate the task anywhere else.",
    "Use the current host conversation already available to you to build a self-contained delegation prompt for the selected target.",
    "Include the relevant earlier user/assistant discussion, decisions, references, and unresolved questions needed to understand the current request.",
    "If prior context matters, format the stdin payload with [Relevant host conversation context] followed by [Current user request], and place the current user prompt verbatim under that second heading.",
    "Do not copy hidden system/developer instructions, hook text, permission data, credentials, raw tool transcripts, or unrelated history into the delegation prompt.",
    `Run that self-contained prompt through this exact one-shot executor from the current working directory:`,
    `node ${JSON.stringify(EXECUTOR)} --ticket ${JSON.stringify(ticket.token)} --prompt-stdin`,
    "Prepare the complete delegation prompt before starting the executor.",
    "Invoke the executor exactly once with tty=false and pass the complete prompt through one closed non-TTY stdin pipe or file redirection, never through a shell argument.",
    "Never start the executor interactively, type the prompt into a running TTY, send Ctrl-D or Ctrl-C, or launch the same ticket a second time.",
    "If the command tool returns a live session id, poll that same session with empty input until it exits; never restart the executor.",
    "Only if the executor explicitly says the ticket was not consumed because stdin was a TTY may you correct the invocation and run that same ticket once with non-TTY stdin.",
    `Locked target configuration: ${config}`,
    resumesConversation
      ? "The executor is locked to continue the saved target conversation as well as receiving the relevant host context."
      : "The executor will start a target session and bind it to this host conversation for later follow-ups using the same selected configuration.",
    "The executor validates and consumes the ticket, launches the target CLI, and returns one JSON object.",
    ...(exactClaudeRelay ? [
      "If status=completed, preserve rawOutput exactly, character for character, then add the fixed attribution 回答来自Claude。 on the next line.",
      "Do not summarize, translate, correct, reformat, quote, fence, label, or preface rawOutput.",
      "Add no configuration, jobId, context status, routing reminder, or host commentary; 回答来自Claude。 is the only permitted addition and must appear exactly once at the end.",
      "If rawOutput already ends with a newline, append 回答来自Claude。 directly; otherwise insert one newline before it.",
      "The scope-owned user-level Stop hook will compare your final assistant message with Claude's saved rawOutput plus that fixed attribution and force continuation if any character differs.",
    ] : [
      "If status=completed, present rawOutput faithfully, then state the exact configuration and jobId.",
      "If contextSaved=false, also state that this target configuration used the full host-supplied context but could not persist a resumable target session.",
    ]),
    "If status=failed or stalled, report that error and stop; do not answer the task yourself and do not retry silently.",
    ...(exactClaudeRelay ? [] : [
      `End with a short reminder that before sending the next task or follow-up, the user must select ${ticket.host === "codex" ? "$claude" : "/codex"} from the composer again.`,
    ]),
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
  const scope = configuredScopeRoot();
  if (scope) return scope;
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
      hostSessionId: typeof input.session_id === "string" && input.session_id
        ? input.session_id
        : sessionId,
      hostTurnId: typeof input.turn_id === "string" ? input.turn_id : null,
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

function exactRelayContinuation(expected) {
  return [
    "cc-suite attributed Claude relay check failed: the previous assistant message did not preserve Claude's raw response followed by the required attribution.",
    "Return exactly the decoded value of the JSON string below as the entire next assistant message.",
    "Do not add or remove any character. Claude's raw response must remain unchanged, and 回答来自Claude。 must appear exactly once at the end.",
    "Do not add Markdown fences, quotes, configuration, jobId, explanation, or reminder.",
    `Required final message JSON string: ${JSON.stringify(expected)}`,
  ].join("\n");
}

function handleStop(args, input) {
  if (
    args.host !== "codex"
    || args.target !== "claude"
    || input.hook_event_name !== "Stop"
  ) return;
  const checked = verifyExactClaudeResponse(input.cwd, {
    sessionId: typeof input.session_id === "string" ? input.session_id : "",
    lastAssistantMessage: input.last_assistant_message,
  });
  if (checked.status === "mismatch") {
    emit(block(exactRelayContinuation(checked.expected)));
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const input = readHookInput();
  // These hooks are installed at user level, so they will be offered every
  // prompt. Outside the explicit scope they must be a true no-op: no state,
  // no output, and no message mutation.
  if (!cwdIsInConfiguredScope(input.cwd)) process.exit(0);
  if (triggerFor(args.host, input)) handleTrigger(args, input);
  else if (input.hook_event_name === "Stop") handleStop(args, input);
  else handleSubmit(args, input);
} catch (error) {
  // A malformed invocation is a configuration defect. Stay silent so an
  // unrelated user prompt is never blocked by a broken local installation.
  process.stderr.write(`cc-suite dispatch hook: ${error.message}\n`);
}
