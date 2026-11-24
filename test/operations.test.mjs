import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Engine } from '../src/engine.mjs';
import { bindingFile, retireBinding } from '../src/bindings.mjs';
import { Operations, submit, operation, waitOperation } from '../src/operations.mjs';
import { blocked } from '../src/fences.mjs';
import { ensureProfiles } from '../src/profiles.mjs';
import { readJson, writeJson, acquireLock } from '../src/storage.mjs';
import { taskFile, threadTaskFile } from '../src/tasks.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-operations-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const home = path.join(dir, 'codex'), sessions = path.join(home, 'sessions'); fs.mkdirSync(sessions, { recursive: true });
  const id = randomUUID(), source = path.join(sessions, 'rollout.jsonl'); fs.writeFileSync(source, '');
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite')); db.exec('CREATE TABLE threads(id TEXT,cwd TEXT,rollout_path TEXT,source TEXT,thread_source TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run(id, '/ordinary-project', source, 'vscode', 'agent_created_thread'); db.close();
  const c = { stateDir: path.join(dir, 'state'), codexHome: home, workspaceId: 'workspace', workspaceSlug: 'ws', serverUrl: 'http://fixture', retryLimit: 10, toolPayloads: true };
  ensureProfiles(c);
  writeJson(taskFile(c, 'work'), { key: 'work', issueId: 'issue', identifier: 'TEST-1', title: '任务', resources: [], profileKey: 'general', profileVersion: 1 });
  writeJson(path.join(c.stateDir, 'remote-registry.json'), { installationId: 'fixture', registered: true, runtimeId: 'runtime', heartbeatAt: Date.now(), agents: { general: { id: 'agent', projectedVersion: 1 } } });
  const requests = [], tasks = [], comments = [], rows = [], outputs = [], submissions = new Map(); let sessionCount = 0, hold;
  const api = { async request(method, url, body, options = {}) {
    options.beforeSend?.(); requests.push({ method, url, body });
    if (method === 'GET' && url === '/api/issues/issue') return { id: 'issue', parent_issue_id: null };
    if (url.endsWith('/heartbeat')) return {};
    if (url === '/api/chat/sessions') return { id: 'session-' + ++sessionCount };
    if (url === '/api/agents') return [{ id: 'agent' }];
    if (url.endsWith('/comments')) { if (method === 'POST') comments.push({ id: String(comments.length), ...body }); return comments; }
    if (/chat\/sessions\/[^/]+\/messages$/.test(url)) {
      let task = submissions.get(body.submission_id);
      if (!task) { task = { id: 'task-' + (tasks.length + 1), status: 'pending' }; tasks.push(task); submissions.set(body.submission_id, task); }
      return { task_id: task.id };
    }
    if (url.includes('/agents/') && url.includes('/tasks')) return tasks;
    if (url.endsWith('/claim')) { const task = tasks.find(t => t.status === 'pending'); if (task) task.status = 'dispatched'; return { task }; }
    const task = tasks.find(t => url.includes('/tasks/' + t.id + '/'));
    if (url.endsWith('/start')) { task.status = 'running'; return {}; }
    if (url.endsWith('/messages')) {
      if (hold) { const h = hold; hold = null; await h(); }
      rows.push(...body.messages); return {};
    }
    if (url.endsWith('/complete')) { task.status = 'completed'; outputs.push(body.output); return {}; }
    throw new Error('Unexpected ' + method + ' ' + url);
  } };
  const engine = new Engine(c, api); let ops = new Operations(c, engine);
  const load = () => readJson(bindingFile(c, id));
  function append(type, payload, timestamp = new Date().toISOString()) { fs.appendFileSync(source, JSON.stringify({ type, timestamp, payload }) + '\n'); }
  const begin = turn => append('event_msg', { type: 'task_started', turn_id: turn });
  const answer = (text, turn) => append('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', internal_chat_message_metadata_passthrough: { turn_id: turn }, content: [{ type: 'output_text', text }] });
  const end = turn => append('event_msg', { type: 'task_complete', turn_id: turn });
  async function control(action, extra = {}) { const op = submit(c, { thread_id: id, key: action === 'connect' ? 'work' : undefined, action, ...extra }); await ops.tick(); const result = operation(c, op.requestId); assert.equal(result.status, 'confirmed', JSON.stringify(result)); return result; }
  async function tick() { const b = load(); b.retryAt = 0; await engine.tick(b); assert.equal(b.lastError, undefined); }
  return { c, id, engine, api, load, append, begin, answer, end, control, tick, rows, requests, outputs, tasks,
    get sessions() { return sessionCount; }, hold(fn) { hold = fn; }, restart() { ops = new Operations(c, engine); }, pump: () => ops.tick() };
}
test('connect starts at confirmed EOF, pause keeps output local, resume reuses identities without backfill', async t => {
  const f = fixture(t); f.begin('old'); f.answer('PRIVATE_HISTORY', 'old');
  const connected = await f.control('connect'); assert.equal(connected.result.generation, 1); assert.equal(f.sessions, 1);
  assert.equal(connected.result.titleAction.prefix, 'M-'); assert.equal(connected.result.titleAction.threadId, f.id);
  f.answer('published one', 'old'); f.end('old'); await f.tick();
  const paused = await f.control('pause', { expected_generation: 1 }); assert.equal(paused.result.localStopped, true);
  f.begin('private'); f.answer('PRIVATE_DURING_PAUSE', 'private'); f.end('private'); await f.tick();
  const resumed = await f.control('resume', { expected_generation: 2 }); assert.equal(resumed.result.sessionId, connected.result.sessionId);
  f.begin('public'); f.answer('published two', 'public'); f.end('public'); await f.tick();
  assert.equal(f.sessions, 1); assert.equal(f.tasks.length, 2);
  assert.deepEqual(f.outputs, ['published one', 'published two']);
  assert.equal(JSON.stringify(f.requests).includes('PRIVATE_'), false);
  assert.ok(f.requests.filter(r => /chat\/sessions\/.*\/messages/.test(r.url)).every(r => r.body.content === '用户消息'));
});
test('old bindings are retired, never executed, and retain their historical remote IDs', async t => {
  const f = fixture(t); await f.control('connect'); const b = f.load();
  delete b.protocol; b.pending = [{ kind: 'assistant', text: 'OLD_UNSENT_CONTENT' }];
  b.nextProfile = { key: 'unused' }; b.instructionsLoadedVersion = 1;
  assert.equal(retireBinding(f.c, b), true); assert.equal(b.enabled, false); assert.equal(b.protocol, 'retired');
  assert.equal(b.remote.sessionId, 'session-1'); assert.equal(b.pending.length, 0); assert.equal(b.nextProfile, undefined);
  const count = f.requests.length; await f.engine.tick(b); assert.equal(f.requests.length, count);
});
test('pause ACK waits for an in-flight write and blocks the remaining queued output', async t => {
  const f = fixture(t); f.begin('turn'); await f.control('connect');
  f.answer('already in flight', 'turn'); f.answer('PRIVATE_PENDING', 'turn');
  let started, release; const inFlight = new Promise(r => { started = r; }), done = new Promise(r => { release = r; });
  f.hold(async () => { started(); await done; });
  const tick = f.tick(); await inFlight;
  const op = submit(f.c, { thread_id: f.id, action: 'pause' });
  assert.equal(blocked(f.c, f.id), true); assert.equal((await waitOperation(f.c, op.requestId, 5)).status, 'pending');
  release(); await tick; await f.pump();
  assert.equal(operation(f.c, op.requestId).status, 'confirmed');
  assert.equal(JSON.stringify(f.requests).includes('PRIVATE_PENDING'), false);
  const count = f.requests.length; f.answer('PRIVATE_AFTER_ACK', 'turn'); await f.tick(); assert.equal(f.requests.length, count);
});
test('operation IDs are idempotent, stale generations fail, and pause survives a restart', async t => {
  const f = fixture(t); f.begin('turn'); const id = randomUUID();
  const args = { thread_id: f.id, action: 'connect', key: 'work', request_id: id, expected_generation: 0 };
  submit(f.c, args); submit(f.c, args); await f.pump(); assert.equal(f.sessions, 1);
  assert.throws(() => submit(f.c, { ...args, action: 'resume' }), /already used/);
  assert.throws(() => submit(f.c, { thread_id: f.id, action: 'pause', expected_generation: 0 }), /generation changed/);
  const pause = submit(f.c, { thread_id: f.id, action: 'pause' }); f.restart(); await f.pump();
  assert.equal(operation(f.c, pause.requestId).result.localStopped, true);
  assert.equal(blocked(f.c, f.id), false); assert.equal(f.load().enabled, false);
});
test('the daemon cannot acknowledge an operation while its publishing lock is held', async t => {
  const f = fixture(t), op = submit(f.c, { thread_id: f.id, action: 'connect', key: 'work' });
  const release = acquireLock(path.join(f.c.stateDir, 'operation-queue.lock'));
  try { await f.pump(); assert.equal(operation(f.c, op.requestId).status, 'pending'); assert.equal(blocked(f.c, f.id), true); }
  finally { release(); }
  await f.pump(); assert.equal(operation(f.c, op.requestId).status, 'confirmed'); assert.equal(blocked(f.c, f.id), false);
});
test('late tool results and bridge control tool payloads do not cross a resume boundary', async t => {
  const f = fixture(t); f.begin('turn'); await f.control('connect');
  f.append('response_item', { type: 'function_call', name: 'business', call_id: 'late', arguments: '{}' }); await f.tick();
  await f.control('pause'); await f.control('resume');
  f.append('response_item', { type: 'function_call_output', call_id: 'late', output: 'PRIVATE_LATE_OUTPUT' });
  f.append('response_item', { type: 'function_call', name: 'exec', call_id: 'local', arguments: JSON.stringify({ code: 'mcp__multica_bridge__get_task_context()' }) });
  f.append('response_item', { type: 'function_call_output', call_id: 'local', output: 'PRIVATE_LOCAL_RESOURCE' });
  f.answer('safe reply', 'turn'); f.end('turn'); await f.tick();
  assert.equal(JSON.stringify(f.requests).includes('PRIVATE_'), false); assert.ok(f.outputs.includes('safe reply'));
});
test('a later pause supersedes a connecting operation that is waiting for Multica', async t => {
  const f = fixture(t); const original = f.api.request.bind(f.api);
  f.api.request = async (method, url, body, options) => { if (url === '/api/chat/sessions') throw Object.assign(new Error('closed'), { suspended: true }); return original(method, url, body, options); };
  const connect = submit(f.c, { thread_id: f.id, action: 'connect', key: 'work' }); await f.pump();
  assert.equal(operation(f.c, connect.requestId).status, 'pending');
  const pause = submit(f.c, { thread_id: f.id, action: 'pause' }); await f.pump();
  assert.equal(operation(f.c, connect.requestId).status, 'superseded'); assert.equal(operation(f.c, pause.requestId).result.localStopped, true);
});

test('child sync binding is rejected before a Chat or a queue fence is created', async t => {
  const f = fixture(t);
  const child = { ...readJson(taskFile(f.c, 'work')), key: 'child', issueId: 'child-issue', parentIssueId: 'issue', parentKey: 'work' };
  writeJson(taskFile(f.c, 'child'), child);
  assert.throws(() => submit(f.c, { action: 'connect', thread_id: f.id, key: 'child' }), /connect the parent/);
  assert.equal(f.sessions, 0); assert.equal(blocked(f.c, f.id), false);
});


test('remote child rejection leaves no task association and permits connecting the correct parent', async t => {
  const f = fixture(t), original = f.api.request.bind(f.api);
  f.api.request = async (method, url, ...args) => {
    if (url === '/api/issues/issue') return { id: 'issue', parent_issue_id: 'parent-issue' };
    if (url === '/api/issues/parent-issue') return { id: 'parent-issue', parent_issue_id: null };
    return original(method, url, ...args);
  };
  const rejected = submit(f.c, { thread_id: f.id, action: 'connect', key: 'work' }); await f.pump();
  assert.equal(operation(f.c, rejected.requestId).status, 'failed');
  assert.equal(fs.existsSync(threadTaskFile(f.c, f.id)), false);
  assert.equal(f.load().enabled, false); assert.equal(f.sessions, 0);
  writeJson(taskFile(f.c, 'parent'), { ...readJson(taskFile(f.c, 'work')), key: 'parent', issueId: 'parent-issue' });
  const connected = submit(f.c, { thread_id: f.id, action: 'connect', key: 'parent' }); await f.pump();
  assert.equal(operation(f.c, connected.requestId).status, 'confirmed');
  assert.equal(readJson(threadTaskFile(f.c, f.id)).key, 'parent'); assert.equal(f.sessions, 1);
});
test('resume rejects a remotely reparented task and preserves its paused window and original Chat', async t => {
  const f = fixture(t); await f.control('connect'); await f.control('pause');
  const before = f.load(), original = f.api.request.bind(f.api); let reparented = true;
  f.api.request = async (method, url, ...args) => url === '/api/issues/issue'
    ? { id: 'issue', parent_issue_id: reparented ? 'other-parent' : null } : original(method, url, ...args);
  const op = submit(f.c, { thread_id: f.id, action: 'resume', expected_generation: before.generation }); await f.pump();
  assert.equal(operation(f.c, op.requestId).status, 'failed');
  assert.equal(f.load().enabled, false); assert.equal(f.load().generation, before.generation);
  assert.equal(f.load().remote.sessionId, before.remote.sessionId); assert.equal(f.sessions, 1);
  f.begin('private'); f.answer('PRIVATE_AFTER_REJECTED_RESUME', 'private'); f.end('private'); await f.tick();
  assert.equal(JSON.stringify(f.rows).includes('PRIVATE_AFTER_REJECTED_RESUME'), false);
  reparented = false;
  await f.control('resume', { expected_generation: before.generation });
  f.begin('public'); f.answer('safe after recovery', 'public'); f.end('public'); await f.tick();
  assert.equal(f.sessions, 1); assert.ok(f.rows.some(r => r.content === 'safe after recovery'));
  assert.equal(JSON.stringify(f.rows).includes('PRIVATE_AFTER_REJECTED_RESUME'), false);
});
test('a pending parent validation can still be paused without committing an association', async t => {
  const f = fixture(t), original = f.api.request.bind(f.api);
  f.api.request = async (method, url, ...args) => { if (url === '/api/issues/issue') throw Object.assign(new Error('Multica closed'), { suspended: true }); return original(method, url, ...args); };
  const connect = submit(f.c, { thread_id: f.id, action: 'connect', key: 'work' }); await f.pump();
  assert.equal(operation(f.c, connect.requestId).status, 'pending');
  assert.equal(f.load().enabled, false); assert.equal(fs.existsSync(threadTaskFile(f.c, f.id)), false);
  const pause = submit(f.c, { thread_id: f.id, action: 'pause' }); await f.pump();
  assert.equal(operation(f.c, connect.requestId).status, 'superseded'); assert.equal(operation(f.c, pause.requestId).status, 'confirmed');
  assert.equal(f.sessions, 0);
});
