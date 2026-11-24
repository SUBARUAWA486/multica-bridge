import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClientLifecycle } from '../src/client-lifecycle.mjs';
import { bindingFile } from '../src/bindings.mjs';
import { readJson, writeJson } from '../src/storage.mjs';
import { readWindowRecords } from '../src/windows.mjs';

test('reopen rebuilds a turn begun while closed, preserves accepted queue and skips closed content', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-window-reopen-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const source = path.join(dir, 'trace.jsonl'); fs.writeFileSync(source, '');
  const c = { stateDir: dir }, b = { id: '00000000-0000-4000-a000-000000000001', enabled: true, source, inode: fs.statSync(source).ino, offset: 0, pending: [], windowStartedAt: '2020-01-01T00:00:00Z' };
  const append = (type, payload) => fs.appendFileSync(source, JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + '\n');
  append('event_msg', { type: 'task_started', turn_id: 'old' });
  append('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'accepted before close' }] });
  readWindowRecords(b, {}); b.pending.shift();
  const engine = { save(v) { writeJson(bindingFile(c, v.id), v); }, registry: { data: { registered: true }, save() {} } }; engine.save(b);
  const lifecycle = new ClientLifecycle(c, engine); lifecycle.suspend();
  append('event_msg', { type: 'task_complete', turn_id: 'old' });
  append('event_msg', { type: 'task_started', turn_id: 'new' });
  append('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'private while closed' }] });
  lifecycle.resume(); const resumed = readJson(bindingFile(c, b.id));
  assert.equal(resumed.windowTurn, 'new'); assert.equal(resumed.captureTurn, 'new');
  append('response_item', { type: 'message', role: 'assistant', internal_chat_message_metadata_passthrough: { turn_id: 'new' }, content: [{ type: 'output_text', text: 'public after reopen' }] });
  readWindowRecords(resumed, {});
  assert.deepEqual(resumed.pending.map(e => e.text), ['accepted before close', 'public after reopen']);
});
