import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine, userMessagePlaceholder } from '../src/engine.mjs';
import { bindingFile } from '../src/bindings.mjs';
import { readJson, writeJson } from '../src/storage.mjs';
import { ensureProfiles } from '../src/profiles.mjs';
import { taskFile, threadTaskFile } from '../src/tasks.mjs';
import { API } from '../src/api.mjs';
import { ClientClosedError } from '../src/client-gate.mjs';

function fixture(t, records) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-engine-')); t.after(() => fs.rmSync(stateDir, { recursive: true }));
  const source = path.join(stateDir, 'rollout'); fs.writeFileSync(source, '');
  const c = { stateDir, workspaceId: 'workspace', retryLimit: 10 };
  ensureProfiles(c);
  writeJson(path.join(stateDir, 'remote-registry.json'), { installationId: 'fixture', registered: true, runtimeId: 'runtime', heartbeatAt: Date.now(), agents: { general: { id: 'agent', projectedVersion: 1 } } });
  const b = { protocol: 'windows-v1', id: '00000000-0000-4000-a000-000000000001', profileKey: 'general', profileVersion: 1, source, inode: fs.statSync(source).ino, offset: 0, enabled: true, errors: 0, rows: 0, turns: 0, remote: { runtimeId: 'runtime', agentId: 'agent', sessionId: 'session' }, pending: records };
  let failMessageOnce = false, failSendOnce = false, taskCount = 0;
  const tasks = [], rows = new Map(), submissions = new Map(), outputs = [], sentInputs = [];
  const api = { async request(method, url, body) {
    if (url.endsWith('/heartbeat')) return {};
    if (url.endsWith('/register')) return { runtimes: [{ id: 'runtime' }] };
    if (/^\/api\/chat\/sessions\/[^/]+\/messages$/.test(url)) {
      sentInputs.push(body.content);
      let task = submissions.get(body.submission_id);
      if (!task) { task = { id: `task${++taskCount}`, status: 'pending', chat_session_id: url.split('/')[4] }; tasks.push(task); submissions.set(body.submission_id, task); }
      if (failSendOnce) { failSendOnce = false; throw new Error('Network lost after submission committed'); }
      return { task_id: task.id };
    }
    if (/\/agents\/[^/]+\/tasks/.test(url)) return tasks;
    if (url.includes('/tasks/claim')) { const task = tasks.find(x => x.status === 'pending'); if (task) task.status = 'dispatched'; return { task }; }
    const id = url.match(/tasks\/(task\d+)/)?.[1]; const task = tasks.find(x => x.id === id);
    if (url.endsWith('/start')) { task.status = 'running'; return {}; }
    if (url.endsWith('/messages')) {
      for (const row of body.messages) rows.set(id + ':' + row.idempotency_key, row);
      if (failMessageOnce) { failMessageOnce = false; throw new Error('Connection lost after rows committed'); }
      return {};
    }
    if (url.endsWith('/complete')) { assert.ok(['running', 'completed'].includes(task.status), 'complete requires a started task'); task.status = 'completed'; outputs.push(body.output); return {}; }
    if (url.endsWith('/deregister')) return {};
    throw new Error('Unexpected endpoint ' + url);
  } };
  const engine = new Engine(c, api);
  return { c, b, engine, tasks, rows, outputs, sentInputs, failMessage() { failMessageOnce = true; }, failSend() { failSendOnce = true; } };
}
const e = (kind, key, extra = {}) => ({ kind, key, at: '2026-11-18T08:00:00Z', ...extra });
test('new source records do not discard a previous turn waiting for a network retry', async t => {
  const f = fixture(t, []); f.b.windowStartedAt = '2020-01-01T00:00:00Z';
  function turn(id) {
    for (const [type, payload] of [['event_msg', { type: 'task_started', turn_id: id }], ['response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'private input' }] }], ['response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'answer ' + id }] }], ['event_msg', { type: 'task_complete', turn_id: id }]]) fs.appendFileSync(f.b.source, JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + '\n');
  }
  turn('T'); f.failSend(); await f.engine.tick(f.b); assert.ok(f.b.pending.length);
  turn('U'); const b = readJson(bindingFile(f.c, f.b.id)); b.retryAt = 0; await new Engine(f.c, f.engine.api).tick(b);
  assert.deepEqual(f.outputs, ['answer T', 'answer U']); assert.equal(b.pending.length, 0); assert.equal(f.tasks.length, 2);
});
test('a client gate rejection before dispatch leaves Chat creation safely retryable', async t => {
  const f = fixture(t, []); f.b.remote = {};
  f.engine.api = new API(f.c, { gate: { async signal() { throw new ClientClosedError(); } } });
  await assert.rejects(f.engine.ensureRemote(f.b), err => err.requestDelivery === 'not_sent');
  assert.equal(f.b.remote.sessionCreation, 'not_sent');
  const calls = [], api = { async request(method, url) { calls.push({ method, url }); if (method === 'POST' && url === '/api/chat/sessions') return { id: 'created' }; throw new Error('Unexpected ' + url); } };
  await new Engine(f.c, api).ensureRemote(f.b);
  assert.equal(f.b.remote.sessionId, 'created'); assert.equal(f.b.remote.sessionCreation, 'confirmed'); assert.equal(calls.length, 1);
});
test('a lost Chat creation acknowledgement reconciles the existing Chat instead of recreating it', async t => {
  const f = fixture(t, []); f.b.remote = {}; let posts = 0;
  f.engine.api = { async request(method, url, body, options) {
    if (method === 'POST') { posts++; options.onDispatch(); throw new Error('lost acknowledgement'); }
    return [{ id: 'existing', title: f.b.remote.sessionTitle, agent_id: 'agent' }];
  } };
  await assert.rejects(f.engine.ensureRemote(f.b), /lost acknowledgement/); assert.equal(f.b.remote.sessionCreation, 'unknown');
  await f.engine.ensureRemote(f.b); assert.equal(f.b.remote.sessionId, 'existing'); assert.equal(posts, 1);
});
test('an explicitly attached idle chat gets a task link without starting a mirror run', async t => {
  const f = fixture(t, []), comments = []; f.b.remote = {};
  writeJson(taskFile(f.c, 'work'), { key: 'work', issueId: 'issue', profileKey: 'general', profileVersion: 1, resources: [], publishResults: true });
  writeJson(threadTaskFile(f.c, f.b.id), { key: 'work' });
  const original = f.engine.api.request.bind(f.engine.api);
  f.engine.api.request = async (method, url, body) => {
    if (url === '/api/chat/sessions') return { id: 'new-session' };
    if (url === '/api/agents') return [{ id: 'agent' }];
    if (url.endsWith('/comments')) { if (method === 'POST') comments.push(body); return method === 'GET' ? comments : { id: 'link' }; }
    return original(method, url, body);
  };
  await f.engine.tick(f.b); await f.engine.tick(f.b);
  assert.equal(f.b.linkedSession, 'new-session'); assert.equal(comments.length, 1); assert.equal(f.tasks.length, 0);
});
test('two user turns create exactly two completed mirror tasks with actual final replies', async t => {
  const f = fixture(t, [e('begin', 'b1', { turnId: 'turn1' }), e('user', 'u1', { text: 'first' }), e('assistant', 'a1', { text: 'progress' }), e('assistant', 'a2', { text: 'done first', final: true }), e('end', 'end1'), e('begin', 'b2', { turnId: 'turn2' }), e('user', 'u2', { text: 'second' }), e('assistant', 'a3', { text: 'done second', final: true }), e('end', 'end2')]);
  await f.engine.tick(f.b);
  assert.equal(f.tasks.length, 2); assert.ok(f.tasks.every(x => x.status === 'completed'));
  assert.deepEqual(f.outputs, ['done first', 'done second']); assert.equal(f.b.pending.length, 0); assert.equal(f.rows.size, 3);
});
test('a mid-turn user steer stays on the same mirror run and is not dropped', async t => {
  const f = fixture(t, [e('begin', 'b', { turnId: 'turn' }), e('user', 'u1', { text: 'initial' }), e('assistant', 'a1', { text: 'working' }), e('user', 'u2', { text: 'additional requirement' }), e('assistant', 'a2', { text: 'answer', final: true }), e('end', 'end', { error: 'usage limit' })]);
  await f.engine.tick(f.b);
  assert.equal(f.tasks.length, 1);
  assert.equal([...f.rows.values()].filter(x => x.content === userMessagePlaceholder).length, 1);
  assert.deepEqual(f.sentInputs, [userMessagePlaceholder]);
  assert.equal(JSON.stringify([...f.rows.values()]).includes('additional requirement'), false);
  assert.match(f.outputs[0], /Codex 执行失败：usage limit/);
});
test('an older pending submission is masked at the outbound boundary after restart', async t => {
  const f = fixture(t, [e('assistant', 'a', { text: 'runtime output' })]);
  f.b.active = { submissionId: 'old', input: 'PRIVATE_OLD_USER_INPUT', inputKey: 'old-key', taskId: null, started: false, seq: 0, profileKey: 'general', profileVersion: 1 };
  await f.engine.tick(f.b);
  assert.deepEqual(f.sentInputs, [userMessagePlaceholder]);
  assert.ok([...f.rows.values()].some(x => x.content === 'runtime output'));
});
test('committed response lost on network is replayed across engine restart without duplicate task or row', async t => {
  const f = fixture(t, [e('begin', 'b', { turnId: 'turn' }), e('user', 'u', { text: 'input' }), e('assistant', 'a', { text: 'answer', final: true }), e('end', 'end')]);
  f.failSend(); await f.engine.tick(f.b); assert.equal(f.tasks.length, 1); assert.equal(f.b.pending[0].kind, 'user');
  let b = readJson(bindingFile(f.c, f.b.id)); b.retryAt = 0; f.failMessage(); await new Engine(f.c, f.engine.api).tick(b);
  assert.equal(f.tasks.length, 1); assert.equal(f.rows.size, 1); assert.equal(b.pending[0].kind, 'assistant');
  b = readJson(bindingFile(f.c, f.b.id)); b.retryAt = 0; b.active.started = false; await new Engine(f.c, f.engine.api).tick(b);
  assert.equal(f.tasks.length, 1); assert.equal(f.rows.size, 1); assert.equal(b.active, null); assert.equal(b.pending.length, 0);
});
test('rejected writes pause without dropping queued events', async t => {
  const f = fixture(t, [e('user', 'u', { text: 'input' })]);
  f.engine.api = { async request() { throw Object.assign(new Error('HTTP 403'), { retryable: false }); } };
  await f.engine.tick(f.b); assert.equal(f.b.paused, true); assert.equal(f.b.pending.length, 1);
});
test('shared runtime routes an already-committed sibling task and completing one chat keeps the other running', async t => {
  const f = fixture(t, [e('user', 'u1', { text: 'first' })]); f.b.turnId = 'turn1';
  f.failSend(); await f.engine.tick(f.b);
  const second = { ...structuredClone(f.b), id: '00000000-0000-4000-a000-000000000002', active: null, turnId: 'turn2', remote: { sessionId: 'session-two' }, pending: [e('user', 'u2', { text: 'second' })], errors: 0, retryAt: 0 };
  f.engine.save(second); await f.engine.tick(second);
  assert.equal(second.paused, undefined); assert.match(second.lastError, /Another mirror session/);
  const first = readJson(bindingFile(f.c, f.b.id)); first.retryAt = 0; await f.engine.tick(first);
  second.retryAt = 0; await f.engine.tick(second);
  assert.equal(f.tasks.length, 2); assert.ok(f.tasks.every(x => x.status === 'running'));
  await f.engine.complete(first, '片段结束');
  assert.equal(f.tasks[0].status, 'completed'); assert.equal(f.tasks[1].status, 'running');
  assert.equal(f.engine.registry.data.registered, true);
});
test('reopen closes a live mirror turn, but locally preserves unsent events if the server already ended it', async t => {
  const f = fixture(t, [e('user', 'u1', { text: 'input' })]); f.b.turnId = 'one'; await f.engine.tick(f.b);
  f.b.pending.push(e('assistant', 'a1', { text: 'before close' })); f.b.clientSuspended = true;
  f.tasks[0].status = 'pending';
  await f.engine.resumeAfterClient(f.b); assert.equal(f.tasks[0].status, 'completed'); assert.equal(f.b.active, null); assert.equal(f.b.clientSuspended, false);
  f.b.pending.push(e('user', 'u2', { text: 'second' })); await f.engine.tick(f.b);
  f.tasks[1].status = 'failed'; f.b.pending.push(e('assistant', 'a2', { text: 'unsent before close' })); f.b.clientSuspended = true;
  await f.engine.resumeAfterClient(f.b); assert.equal(f.b.active, null); assert.equal(f.b.interrupted.events, 1);
  assert.equal(readJson(f.b.interrupted.file).pending[0].text, 'unsent before close'); assert.equal(f.b.pending.length, 0);
});
