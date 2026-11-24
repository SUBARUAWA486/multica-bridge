import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson, acquireLock } from './storage.mjs';
import { threadMetadata } from './source.mjs';
import { moveToPresent } from './windows.mjs';
import { bind, bindingFile, summary } from './bindings.mjs';
import { getTask, threadTaskFile, taskForThread } from './tasks.mjs';
import { fenceFile } from './fences.mjs';
import { list } from './api.mjs';

const uuid = v => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
function operationFile(c, id) { if (!uuid(id)) throw new Error('request_id must be a UUID.'); return path.join(c.stateDir, 'operations', id + '.json'); }
export function operation(c, id) { return readJson(operationFile(c, id)); }

export function submit(c, args) {
  const { thread_id: id, action, request_id: requestId = randomUUID() } = args;
  if (!['connect', 'pause', 'resume'].includes(action)) throw new Error('Unknown sync operation.');
  const file = operationFile(c, requestId), release = acquireLock(path.join(c.stateDir, 'operation-queue.lock'));
  try {
    const existing = readJson(file, null);
    const intent = JSON.stringify({ action, id, key: args.key, generation: args.expected_generation });
    if (existing) { if (existing.intent !== intent) throw new Error('request_id was already used for another operation.'); return existing; }
    const meta = threadMetadata(c, id), b = readJson(bindingFile(c, id), null);
    if (action !== 'connect' && !b) throw new Error('This chat has no sync binding.');
    if (action === 'connect') {
      const task = getTask(c, args.key), prior = taskForThread(c, id);
      if (task.parentIssueId) throw new Error('Child tasks cannot bind a Chat; connect the parent task.');
      if (prior && prior.key !== task.key) throw new Error('This chat is associated with another task. Pause it before an explicit migration.');
    }
    if (args.expected_generation !== undefined && args.expected_generation !== (b?.generation ?? 0)) throw new Error('Sync generation changed; read status before retrying.');
    const counterFile = path.join(c.stateDir, 'operation-sequence.json'), sequence = readJson(counterFile, { value: 0 }).value + 1;
    writeJson(counterFile, { value: sequence });
    const op = { requestId, threadId: id, action, key: args.key, expectedGeneration: args.expected_generation, sequence,
      intent, status: 'pending', requestedAt: new Date().toISOString() };
    writeJson(file, op);
    // The fence is consulted immediately before every subsequent data write.
    // ACK is issued by the daemon only after the previous write has returned.
    writeJson(fenceFile(c, id), { blocked: true, requestId, sequence });
    return op;
  } finally { release(); }
}
export async function waitOperation(c, id, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  do {
    const op = operation(c, id);
    if (op.status !== 'pending') return op;
    await new Promise(r => setTimeout(r, 100));
  } while (Date.now() < until);
  return { ...operation(c, id), status: 'pending', guidance: 'Control not confirmed. Do not emit private content; poll get_operation with this requestId.' };
}
function finish(c, op, result, error) {
  const release = acquireLock(path.join(c.stateDir, 'operation-queue.lock'));
  try {
    const f = readJson(fenceFile(c, op.threadId), null);
    if (f?.requestId === op.requestId) writeJson(fenceFile(c, op.threadId), { ...f, blocked: Boolean(error) });
    // Publish ACK last, after admission state is durable and coherent.
    writeJson(operationFile(c, op.requestId), { ...op, status: error ? 'failed' : 'confirmed', result, error, confirmedAt: new Date().toISOString() });
  } finally { release(); }
}
export class Operations {
  constructor(c, engine) { this.c = c; this.engine = engine; }
  async settle(b) {
    if (!b.active && b.unsettledActive) { b.active = b.unsettledActive; delete b.unsettledActive; }
    if (!b.active) return;
    try {
      if (b.active.taskId) {
        const tasks = list(await this.engine.api.request('GET', `/api/agents/${b.remote.agentId}/tasks?limit=200`), 'tasks');
        const task = tasks.find(t => t.id === b.active.taskId);
        if (!task || ['completed', 'failed', 'cancelled', 'aborted'].includes(task.status)) { b.active = null; delete b.unsettledActive; return; }
      }
      await this.engine.complete(b, '同步片段结束。'); delete b.unsettledActive;
    }
    catch (e) {
      // A local pause can be confirmed while the remote client is closed.
      b.unsettledActive = b.active; b.active = null;
      if (!e.suspended) throw e;
    } finally { this.engine.save(b); }
  }
  async apply(op) {
    const c = this.c, id = op.threadId;
    if (op.action === 'connect') {
      const task = getTask(c, op.key);
      if (task.parentIssueId) throw Object.assign(new Error('Child tasks cannot bind a Chat; connect the parent task.'), { permanent: true });
    }
    let b = readJson(bindingFile(c, id), null);
    if (!b && op.action === 'connect') {
      b = bind(c, id, { profileKey: getTask(c, op.key).profileKey });
      b.enabled = false; b.syncMode = 'paused'; this.engine.save(b);
    }
    if (!b) throw new Error('Binding not found.');
    if (!b.source) {
      const meta = threadMetadata(c, id), stat = fs.statSync(meta.source);
      Object.assign(b, meta, { inode: stat.ino, offset: stat.size });
    }
    if (['connect', 'resume'].includes(op.action)) {
      if (b.controlOperation !== op.requestId && op.expectedGeneration !== undefined && op.expectedGeneration !== (b.generation ?? 0)) throw Object.assign(new Error('Sync generation changed.'), { permanent: true });
      const task = op.action === 'connect' ? getTask(c, op.key) : taskForThread(c, id);
      if (!task || task.parentIssueId) throw Object.assign(new Error('Only top-level tasks can sync; connect the parent task.'), { permanent: true });
      const issue = await this.engine.api.request('GET', `/api/issues/${task.issueId}`);
      if (issue.parent_issue_id) throw Object.assign(new Error('This task is now a child; connect the parent task.'), { permanent: true });
    }
    if (b.controlOperation !== op.requestId) {
      if (op.expectedGeneration !== undefined && op.expectedGeneration !== (b.generation ?? 0)) throw Object.assign(new Error('Sync generation changed.'), { permanent: true });
      if (op.action === 'connect') {
        const prior = taskForThread(c, id);
        if (prior && prior.key !== op.key) throw Object.assign(new Error('Task association changed.'), { permanent: true });
        writeJson(threadTaskFile(c, id), { key: op.key });
      }
      b.protocol = 'windows-v1'; b.enabled = false; b.pending = []; b.paused = false; b.errors = 0;
      delete b.retryAt; delete b.lastError;
      b.controlOperation = op.requestId; b.generation = (b.generation ?? 0) + 1;
      b.syncMode = 'pausing'; this.engine.save(b);
    }
    await this.settle(b);
    if (['connect', 'resume'].includes(op.action)) {
      if (b.unsettledActive) throw Object.assign(new Error('Waiting for Multica to settle the previous run.'), { suspended: true });
      await this.engine.ensureRemote(b);
      // Start boundary is the daemon-confirmed EOF, never the original request.
      moveToPresent(b); b.enabled = true; b.syncMode = 'active';
      b.turnId = `window-${b.generation}-${randomUUID()}`; b.clientSuspended = false;
    } else if (op.action === 'pause') {
      moveToPresent(b); b.enabled = false; b.syncMode = 'paused';
    }
    this.engine.save(b);
    return { ...summary(c, b), localStopped: !b.enabled, remoteSettlementPending: Boolean(b.unsettledActive),
      titleAction: b.enabled ? { threadId: b.id, prefix: 'M-', tool: 'codex_app.set_thread_title', guidance: '保留 Codex 原标题，仅在开头没有 M- 时添加。暂停后保留；使用原生标题工具，不修改数据库。' } : undefined,
      boundary: { offset: b.offset, at: b.windowStartedAt }, guidance: !b.enabled ? 'Local sending is stopped; subsequent output stays local.' : 'Only output after this confirmed boundary is eligible.' };
  }
  async tick() {
    const dir = path.join(this.c.stateDir, 'operations');
    if (!fs.existsSync(dir)) return;
    let release;
    try { release = acquireLock(path.join(this.c.stateDir, 'operation-queue.lock')); }
    catch { return; } // A submitter has not finished publishing its fence yet.
    let pending;
    try { pending = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => readJson(path.join(dir, f))).filter(op => op.status === 'pending').sort((a, b) => a.sequence - b.sequence); }
    finally { release(); }
    const pauses = new Map(pending.filter(op => op.action === 'pause').map(op => [op.threadId, op.sequence]));
    const waiting = new Set();
    for (const op of pending) {
      if (pauses.get(op.threadId) > op.sequence) {
        writeJson(operationFile(this.c, op.requestId), { ...op, status: 'superseded', guidance: 'Superseded by a later pause request.' });
        continue;
      }
      if (waiting.has(op.threadId)) continue;
      try { finish(this.c, op, await this.apply(op)); }
      catch (e) {
        if (e.permanent || e.retryable === false) finish(this.c, op, undefined, e.message);
        else { waiting.add(op.threadId); writeJson(operationFile(this.c, op.requestId), { ...op, lastError: e.message }); }
      }
    }
  }
}
