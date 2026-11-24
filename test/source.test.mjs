import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertRecord, readSourceBatch, threadMetadata } from '../src/source.mjs';
import { DatabaseSync } from 'node:sqlite';

const record = p => ({ type: 'response_item', timestamp: '2026-11-18T08:00:00Z', payload: p });
test('explicit selection rejects internal approval and subagent sessions', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-discovery-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  fs.mkdirSync(path.join(dir, 'sessions')); const source = path.join(dir, 'sessions', 'rollout.jsonl'); fs.writeFileSync(source, '');
  const db = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT,cwd TEXT,created_at INTEGER,archived INTEGER,source TEXT,thread_source TEXT,agent_role TEXT,rollout_path TEXT)');
  const insert = db.prepare('INSERT INTO threads VALUES (?,?,100,0,?,?,NULL,NULL)');
  insert.run('normal', '/execution', 'vscode', 'agent_created_thread');
  insert.run('guardian', '/execution', '{"subagent":{"other":"guardian"}}', 'guardian_review');
  insert.run('child', '/execution', '{"subagent":{"spawn":{}}}', null);
  insert.run('ordinary', '/elsewhere', 'vscode', null); db.close();
  const c = { codexHome: dir, mirrorRoot: '/execution', enabledAt: 0 };
  const update = new DatabaseSync(path.join(dir, 'state_5.sqlite')); update.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(source, 'normal'); update.close();
  assert.equal(threadMetadata(c, 'normal').threadId, 'normal');
  assert.throws(() => threadMetadata(c, 'child'), /Internal Codex/);
  assert.throws(() => threadMetadata(c, 'guardian'), /Internal Codex/);
});
test('publishes user input, visible answers and tool correlation; excludes reasoning and injected context', () => {
  assert.equal(convertRecord(record({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '请修改项目' }] })).text, '请修改项目');
  assert.equal(convertRecord(record({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '完成' }] })).final, true);
  assert.equal(convertRecord(record({ type: 'reasoning', summary: 'private' })), null);
  assert.equal(convertRecord(record({ type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'private' }] })), null);
  assert.equal(convertRecord(record({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'private' }] })), null);
  assert.equal(convertRecord(record({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>private</environment_context>' }] })), null);
  const e = convertRecord(record({ type: 'function_call', name: 'exec', call_id: 'one', arguments: '{"token":"secret","cmd":"pwd"}' }), { toolPayloads: true });
  assert.equal(e.callId, 'one'); assert.equal(e.input.token, '[REDACTED]'); assert.equal(e.input.cmd, 'pwd');
  const observed = convertRecord({ type: 'turn_context', timestamp: 'now', payload: { model: 'actual-model', effort: 'high' } });
  assert.equal(observed.kind, 'configuration'); assert.equal(observed.model, 'actual-model');
});
test('partial UTF-8 records survive restarts without corrupting Chinese text or replaying old content', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-source-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const source = path.join(dir, 'trace.jsonl'); fs.writeFileSync(source, '');
  const b = { source, inode: fs.statSync(source).ino, offset: 0, pending: [] };
  const buf = Buffer.from(JSON.stringify(record({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '中文输入😀' }] })) + '\n');
  const split = buf.indexOf(Buffer.from('中文')) + 1;
  fs.appendFileSync(source, buf.subarray(0, split)); assert.equal(readSourceBatch(b, {}).changed, false); assert.equal(b.offset, 0);
  fs.appendFileSync(source, buf.subarray(split)); const batch = readSourceBatch(b, {}); assert.equal(batch.changed, true);
  assert.equal(batch.events[0].text, '中文输入😀'); assert.equal(readSourceBatch(b, {}).changed, false);
  fs.truncateSync(source, 0); assert.throws(() => readSourceBatch(b, {}), /changed or truncated/);
});
test('native app delegation and running follow-ups are visible input, with local paths concealed', () => {
  for (const name of ['create_thread', 'send_message_to_thread']) {
    const event = convertRecord(record({ type: 'function_call_output', name, output: '<codex_delegation>\n<source_thread_id>parent</source_thread_id>\n<input>检查 /Users/worker/repo/main.go</input>\n</codex_delegation>' }));
    assert.equal(event.kind, 'user'); assert.equal(event.text, '检查 [本地路径]');
  }
  const end = convertRecord({ type: 'event_msg', payload: { type: 'task_complete', error: { message: 'usage limit' } } });
  assert.equal(end.error, 'usage limit');
});
test('combined AGENTS, environment and permissions injection is omitted without losing business input', () => {
  const injected = '# AGENTS.md instructions for /Users/test/execution-project\n\n<INSTRUCTIONS>\n# Synthetic project instructions\nLOCAL_ONLY_SENTINEL\n</INSTRUCTIONS>\n<environment_context>\n<cwd>/Users/test/execution-project</cwd>\n<filesystem><permission_profile>private</permission_profile></filesystem>\n</environment_context>';
  const user = text => record({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  assert.equal(convertRecord(user(injected)), null);
  assert.equal(convertRecord(user(injected + '\n\n请修复日志，保留业务行为。')).text, '请修复日志，保留业务行为。');
  const delegated = convertRecord(record({ type: 'function_call_output', name: 'create_thread', output: `<codex_delegation>\n<input>${injected}\n\n## 目标\n修复日志\n\n<multica_local_context>\n调用本机工具 key=test\n</multica_local_context></input>\n</codex_delegation>` }));
  assert.equal(delegated.text, '## 目标\n修复日志');
  const ordinary = '请解释 AGENTS.md 中的权限规则，不要修改文件。';
  assert.equal(convertRecord(user(ordinary)).text, ordinary);
});
