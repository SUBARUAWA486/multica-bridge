import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClientLifecycle } from '../src/client-lifecycle.mjs';
import { bindingFile } from '../src/bindings.mjs';
import { readJson, writeJson } from '../src/storage.mjs';
import { readSourceBatch } from '../src/source.mjs';

test('does not replay closed-period content, including a record partially written at reopen; keeps pre-close queue', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lifecycle-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const c = { stateDir: dir, autoDiscover: false }, source = path.join(dir, 'trace.jsonl'); fs.writeFileSync(source, '');
  let b = { id: '00000000-0000-4000-a000-000000000001', enabled: true, source, inode: fs.statSync(source).ino, offset: 0, pending: [{ kind: 'assistant', text: 'queued before close' }] };
  const engine = { save(v) { writeJson(bindingFile(c, v.id), v); }, registry: { data: { registered: true }, save() {} } }; engine.save(b);
  let lifecycle = new ClientLifecycle(c, engine); lifecycle.suspend();
  fs.appendFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'closed content' }] } }) + '\n');
  fs.appendFileSync(source, '{"type":"response_item",');
  lifecycle.suspend();
  lifecycle = new ClientLifecycle(c, engine); lifecycle.resume();
  fs.appendFileSync(source, '"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"closed partial"}]}}\n');
  fs.appendFileSync(source, JSON.stringify({ type: 'response_item', timestamp: '2020-01-01T00:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'closed event flushed late' }] } }) + '\n');
  fs.appendFileSync(source, JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'after reopen' }] } }) + '\n');
  b = readJson(bindingFile(c, b.id)); b.pending.push(...readSourceBatch(b, {}).events);
  assert.deepEqual(b.pending.map(x => x.text), ['queued before close', 'after reopen']); assert.equal(engine.registry.data.registered, false);
});
