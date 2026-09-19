import { writeReceipt, readReceipt } from './localchat-receipts.mjs';

export const EXECUTION_MS = 60 * 60 * 1000;
export const SAVE_MS = 55 * 60 * 1000;
// Startup/receipt cleanup allowances are outside the native execution budget.
export const STARTUP_MS = 60_000;
const MAX_TEXT = 128 * 1024;

// Only visible assistant text is checkpointed. Reasoning and tool payloads are
// deliberately excluded. The private working copy is already durable on disk.
export function createCheckpoint({ base, backend, timeoutMs = EXECUTION_MS, interrupt,
  now = Date.now, schedule = setTimeout, unschedule = clearTimeout }) {
  let started, softTimer, closed = false, phase = 'executing', session = null, truncated = false;
  const messages = new Map();
  let anonymous = 0, streamId = null;
  function output() { return [...messages.values()].join('\n\n'); }
  function snapshot() {
    return { schema: 1, backend, phase, native_started_at: started == null ? null : new Date(started).toISOString(),
      save_at: started == null ? null : new Date(started + timeoutMs * 55 / 60).toISOString(),
      deadline_at: started == null ? null : new Date(started + timeoutMs).toISOString(),
      saved_at: new Date(now()).toISOString(), backend_session_id: session,
      raw_output: output(), truncated, partial: phase !== 'executing',
      saved_scope: 'visible-assistant-output-and-existing-private-working-copy' };
  }
  function flush() { const value = snapshot(); writeReceipt(base, 'checkpoint', value); return value; }
  function remember(id, text) {
    if (typeof text !== 'string' || !text) return;
    let value = text;
    while (Buffer.byteLength(value) > MAX_TEXT) { value = value.slice(Math.ceil(value.length / 4)); truncated = true; }
    messages.set(id, value);
    while (Buffer.byteLength(output()) > MAX_TEXT && messages.size > 1) { messages.delete(messages.keys().next().value); truncated = true; }
  }
  return {
    start() {
      // Authentication recovery is still the same task and cannot reset its clock.
      const priorStart = base ? Date.parse(readReceipt(base, 'checkpoint')?.native_started_at ?? '') : NaN;
      started = Number.isFinite(priorStart) ? priorStart : now(); flush();
      softTimer = schedule(() => {
        if (closed) return;
        phase = 'wrapping_up';
        // Even a disk error must not leave inference running past the save boundary.
        try { flush(); } catch { /* Final receipt/recovery reports disk failures. */ } finally { interrupt(); }
      }, Math.max(0, started + timeoutMs * 55 / 60 - now()));
    },
    consume(event) {
      if (backend === 'codex') {
        if (typeof event.thread_id === 'string') session = event.thread_id;
        if (['item.started','item.updated','item.completed'].includes(event.type) && event.item?.type === 'agent_message') remember(event.item.id ?? `a-${anonymous++}`, event.item.text);
      } else {
        if (typeof event.session_id === 'string') session = event.session_id;
        if (event.type === 'stream_event' && !event.parent_tool_use_id) {
          const stream = event.event;
          if (stream?.type === 'message_start') streamId = stream.message?.id ?? `stream-${anonymous++}`;
          if (stream?.type === 'content_block_delta' && stream.delta?.type === 'text_delta' && streamId)
            remember(streamId, (messages.get(streamId) ?? '') + stream.delta.text);
        }
        // Completed messages replace their streamed text using the message ID.
        if (event.type === 'assistant' && !event.parent_tool_use_id) {
          remember(event.message?.id ?? event.uuid ?? `a-${anonymous++}`, (event.message?.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n'));
        }
      }
      flush();
    },
    finish(rawOutput = '', hardDeadline = false) {
      closed = true; unschedule(softTimer);
      if (hardDeadline) phase = 'hard_deadline';
      if (phase === 'executing') return null;
      if (rawOutput.trim()) remember('final', rawOutput);
      const checkpoint = flush();
      return { status: 'partial', threadId: session, checkpoint,
        rawOutput: output() || '已到保存时限，任务尚未完成。已保留任务请求、会话标识（若已产生）和工作副本中已经写入磁盘的文件；本轮没有可返回的助手正文。请检查已有文件，再使用 continue_task 继续。' };
    },
    remainingMs: () => Math.max(1, started + timeoutMs - now()),
    snapshot, flush,
  };
}

export function savedPartial(checkpoint) {
  if (!checkpoint?.partial) return null;
  return { status: 'partial', checkpoint, backend_session_id: checkpoint.backend_session_id ?? null,
    raw_output: checkpoint.raw_output || '任务在保存时限停止，尚未完成。已保留上下文和工作副本中已写入的文件；本轮没有可返回的助手正文。使用 continue_task 继续。' };
}
