import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCheckpoint, EXECUTION_MS, SAVE_MS, savedPartial } from '../scripts/lib/localchat-budget.mjs';
import { readReceipt } from '../scripts/lib/localchat-receipts.mjs';

for (const backend of ['codex','claude']) test(`${backend}: native clock saves at 55 minutes, retains visible progress, and closes as partial`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1_000_000, callback, interrupted = 0, cleared = false;
  const base = path.join(root, 'receipt-test');
  const checkpoint = createCheckpoint({ base, backend, now: () => now,
    schedule(fn, ms) { assert.equal(ms, SAVE_MS); callback = fn; return 7; },
    unschedule(id) { assert.equal(id, 7); cleared = true; }, interrupt() { interrupted++; } });
  assert.equal(EXECUTION_MS, 3600000); assert.equal(SAVE_MS, 3300000);
  checkpoint.start();
  const event = backend === 'codex' ? {type:'item.completed',thread_id:'thread',item:{id:'one',type:'agent_message',text:'已完成第一节；还需第二节。'}}
    : {type:'assistant',session_id:'thread',message:{id:'one',content:[{type:'thinking',thinking:'hidden'},{type:'text',text:'已完成第一节；还需第二节。'}]}};
  checkpoint.consume(event); checkpoint.consume(event);
  checkpoint.consume({type:'item.completed',item:{id:'secret',type:'reasoning',text:'hidden'}});
  let saved = readReceipt(base, 'checkpoint');
  assert.equal(saved.raw_output,'已完成第一节；还需第二节。'); assert(!JSON.stringify(saved).includes('hidden'));
  assert.equal(Date.parse(saved.deadline_at) - Date.parse(saved.native_started_at), EXECUTION_MS);
  now += SAVE_MS; callback(); saved = readReceipt(base,'checkpoint');
  assert.equal(interrupted,1); assert.equal(saved.phase,'wrapping_up');
  const partial = checkpoint.finish(); assert.equal(partial.status,'partial'); assert.equal(partial.threadId,'thread');
  assert.equal(partial.rawOutput,'已完成第一节；还需第二节。'); assert(cleared);
  assert.equal(savedPartial(saved).raw_output,partial.rawOutput);
  assert.equal(fs.statSync(`${base}.checkpoint.json`).mode & 0o777,0o600);
});

test('normal completion clears timer, while hard timeout without visible text returns an honest saved result', () => {
  let callback, interrupts = 0;
  const make = () => createCheckpoint({ backend:'codex',schedule(fn){ callback = fn; },unschedule(){},interrupt(){interrupts++;} });
  const done = make(); done.start(); assert.equal(done.finish('complete'),null); callback(); assert.equal(interrupts,0);
  const killed = make(); killed.start(); const result = killed.finish('',true);
  assert.equal(result.status,'partial'); assert.equal(result.checkpoint.phase,'hard_deadline'); assert.match(result.rawOutput,/没有可返回/);
});

test('checkpoint visible history is bounded and truncation is disclosed', () => {
  const checkpoint = createCheckpoint({ backend:'codex',schedule(){},unschedule(){},interrupt(){} }); checkpoint.start();
  checkpoint.consume({type:'item.completed',item:{id:'large',type:'agent_message',text:'中'.repeat(150000)}});
  assert(Buffer.byteLength(checkpoint.snapshot().raw_output) <= 128*1024); assert.equal(checkpoint.snapshot().truncated,true); checkpoint.finish();
});

test('Claude streaming text is saved before message completion and deduplicated against final assistant text', () => {
 const c=createCheckpoint({backend:'claude',schedule(){},unschedule(){},interrupt(){}}); c.start();
 c.consume({type:'stream_event',event:{type:'message_start',message:{id:'message1'}}});
 c.consume({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Already saved.'}}});
 assert.equal(c.snapshot().raw_output,'Already saved.');
 c.consume({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'hidden'}}});
 c.consume({type:'assistant',message:{id:'message1',content:[{type:'text',text:'Already saved.'}]}});
 assert.equal(c.finish('',true).rawOutput,'Already saved.');
});

test('an authentication-only restart inherits the original native clock', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'budget-restart-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let now=1000000,timeout;
 const make=()=>createCheckpoint({base:path.join(root,'receipt-test'),backend:'claude',now:()=>now,schedule(_fn,ms){timeout=ms;},unschedule(){},interrupt(){}});
 const first=make();first.start();first.finish();now+=10000;
 const second=make();second.start();assert.equal(timeout,SAVE_MS-10000);assert.equal(second.remainingMs(),EXECUTION_MS-10000);second.finish();
});
