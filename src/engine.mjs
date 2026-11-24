import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { API, list } from './api.mjs';
import { writeJson } from './storage.mjs';
import { visibleUserText } from './source.mjs';
import { ensureProfiles, getDefaultProfile, assignProfile } from './profiles.mjs';
import { Registry } from './registry.mjs';
import { taskForThread, postTaskComment } from './tasks.mjs';
import { publicValue } from './privacy.mjs';
import { checkFence, blocked } from './fences.mjs';
import { bindingFile, getBindings } from './bindings.mjs';
import { readWindowRecords } from './windows.mjs';

const uuidFor = value => { const h = createHash('sha256').update(value).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
export const userMessagePlaceholder = '用户消息';
export class Engine {
  constructor(c, api = new API(c)) { this.c = c; this.api = api; ensureProfiles(c); this.registry = new Registry(c, api); }
  save(b) { writeJson(bindingFile(this.c, b.id), b); }
  async request(method, p, body, options = {}) {
    const b = this.currentBinding;
    const guard = () => { if (b) checkFence(this.c, b.id); };
    guard();
    const result = await this.api.request(method, p, body, { ...options, beforeSend: guard });
    if (b) b.lastServerAckAt = new Date().toISOString();
    return result;
  }
  async ensureRemote(b) {
    if (!b.profileKey) assignProfile(this.c, b, getDefaultProfile(this.c).key);
    const r = b.remote;
    r.runtimeId = await this.registry.ensureRuntime();
    r.agentId = await this.registry.ensureAgent(b.profileKey); this.save(b);
    if (!r.sessionId) {
      const task = taskForThread(this.c, b.id);
      const title = r.sessionTitle ?? (task ? `${task.identifier} · ${task.title ?? 'Codex 对话'}` : `Codex 镜像 ${b.id}`);
      r.sessionTitle = title;
      r.sessionCreation ??= r.sessionAttempted ? 'unknown' : 'not_sent';
      if (r.sessionCreation === 'unknown') {
        const sessions = list(await this.request('GET', '/api/chat/sessions?limit=100'), 'sessions');
        const found = sessions.find(s => s.title === title && s.agent_id === r.agentId);
        if (!found) throw Object.assign(new Error('Session creation result is unknown. Inspect the target workspace before retrying creation.'), { permanent: true });
        r.sessionId = found.id;
      } else {
        this.save(b);
        try {
          const session = await this.request('POST', '/api/chat/sessions', { agent_id: r.agentId, title }, {
            onDispatch: () => { r.sessionCreation = 'unknown'; this.save(b); }
          });
          r.sessionId = session.id;
        } catch (e) {
          r.sessionCreation = e.requestDelivery === 'not_sent' ? 'not_sent' : 'unknown'; this.save(b); throw e;
        }
      }
      r.sessionCreation = 'confirmed'; delete r.sessionAttempted;
      this.save(b);
    }
    const task = taskForThread(this.c, b.id);
    if (task && b.linkedSession !== r.sessionId) {
      const url = `${this.c.serverUrl}/${this.c.workspaceSlug}/chat?session=${r.sessionId}`;
      await postTaskComment(this.c, { request: (...args) => this.request(...args) }, task, `[执行对话（实时镜像）](${url})\n\n工作交流在当前 Codex 聊天中进行。`, `link:${b.id}:${r.sessionId}`);
      b.linkedSession = r.sessionId; b.taskKey = task.key; this.save(b);
    }
  }
  async ensureActive(b, event) {
    // A profile switch at a turn boundary can require a different remote session.
    await this.ensureRemote(b);
    if (!b.active) {
      b.active = { submissionId: uuidFor(b.id + ':' + b.turnId), inputKey: event.kind === 'user' ? event.key : null, input: userMessagePlaceholder, taskId: null, started: false, seq: 0, latest: '', final: '', profileKey: b.profileKey, profileVersion: b.profileVersion };
      this.save(b);
    }
    const a = b.active;
    if (!a.taskId) {
      // Enforce at the network boundary too: older persisted active runs may
      // still contain real input. Never replay that input after an upgrade.
      a.input = userMessagePlaceholder;
      const sent = await this.request('POST', `/api/chat/sessions/${b.remote.sessionId}/messages`, { content: userMessagePlaceholder, submission_id: a.submissionId });
      if (!sent.task_id) throw new Error('Server did not return a task ID.');
      a.taskId = sent.task_id; this.save(b);
    }
    if (!a.started) {
      const tasks = list(await this.request('GET', `/api/agents/${b.remote.agentId}/tasks?limit=200`), 'tasks');
      const found = tasks.find(t => t.id === a.taskId);
      if (['completed', 'failed', 'cancelled', 'aborted'].includes(found?.status)) throw Object.assign(new Error(`Mirror task is already ${found.status}; explicit resume required.`), { permanent: true });
      if (found?.status !== 'running') {
        if (found?.status !== 'dispatched') {
          const claim = await this.request('POST', `/api/daemon/runtimes/${b.remote.runtimeId}/tasks/claim`, {});
          if (!claim.task) throw new Error('Mirror task is not ready for claim yet.');
          if (claim.task.id !== a.taskId) {
            const other = getBindings(this.c).find(other => other.active && (other.active.taskId === claim.task.id || (claim.task.chat_session_id && other.remote.sessionId === claim.task.chat_session_id)));
            const known = Boolean(other);
            if (other && !other.active.taskId) { other.active.taskId = claim.task.id; this.save(other); }
            throw Object.assign(new Error(known ? 'Another mirror session was claimed; waiting for its next tick.' : 'Runtime returned an unmanaged task. No model will be started.'), { permanent: !known });
          }
        }
        await this.request('POST', `/api/daemon/tasks/${a.taskId}/start`);
      }
      a.started = true; this.save(b);
    }
    return a;
  }
  async complete(b, label = '') {
    if (!b.active) return;
    const a = b.active;
    if (!a.taskId) await this.ensureActive(b, { kind: 'bootstrap' });
    const text = a.final || a.latest || '此回合没有可见回复。';
    await this.request('POST', `/api/daemon/tasks/${a.taskId}/complete`, { output: label ? `${label}\n\n${text}` : text });
    const task = taskForThread(this.c, b.id);
    if (task?.publishResults) await postTaskComment(this.c, { request: (...args) => this.request(...args) }, task,
      `执行回合记录${label ? '：' + label : ''}\n\n${text.slice(0, 8000)}${text.length > 8000 ? '\n\n（完整内容见执行对话）' : ''}\n\n[完整执行对话](${this.c.serverUrl}/${this.c.workspaceSlug}/chat?session=${b.remote.sessionId})`, `turn:${a.submissionId}`);
    b.active = null; b.turns++; this.save(b);
  }
  async resumeAfterClient(b) {
    if (!b.clientSuspended) return;
    await this.registry.ensureRuntime();
    if (b.active?.taskId) {
      const tasks = list(await this.request('GET', `/api/agents/${b.remote.agentId}/tasks?limit=200`), 'tasks');
      const task = tasks.find(t => t.id === b.active.taskId);
      if (!task || ['completed', 'failed', 'cancelled', 'aborted'].includes(task.status)) {
        // The server may have timed out an old mirror run while the app was closed.
        const file = path.join(this.c.stateDir, 'interrupted', `${b.id}-${Date.now()}.json`);
        writeJson(file, { active: b.active, pending: b.pending, reason: 'Mirror run ended while Multica was closed.' });
        b.interrupted = { file, events: b.pending.length }; b.pending = []; b.active = null;
      } else {
        b.active.started = false; this.save(b);
        await this.ensureActive(b, { kind: 'bootstrap' });
      }
    }
    while (b.pending.length) { await this.processEvent(b, b.pending[0]); b.pending.shift(); this.save(b); }
    await this.complete(b, 'Multica 退出，镜像已暂停；关闭期间内容未同步。');
    b.turnId = `client-resume-${randomUUID()}`; b.clientSuspended = false; this.save(b);
  }
  async processEvent(b, e) {
    if (e.kind === 'begin') {
      if (b.active && b.turnId !== e.turnId) await this.complete(b, '上一回合同步结束。');
      b.turnId = e.turnId || e.key; return;
    }
    if (e.kind === 'configuration') { b.observed = { model: e.model, effort: e.effort, at: e.at }; return; }
    if (e.kind === 'end') { await this.complete(b, e.error ? `Codex 执行失败：${e.error}` : e.interrupted ? 'Codex 回合已中断。' : ''); return; }
    const a = await this.ensureActive(b, e);
    // The actual user message is already the top-level chat message; do not duplicate it in the transcript.
    if (e.kind === 'user' && (a.inputKey === e.key || (!a.inputKey && a.input === e.text))) return;
    let row = { seq: a.seq + 1, idempotency_key: e.key, created_at: e.at, type: ['assistant', 'user'].includes(e.kind) ? 'text' : e.kind };
    if (e.kind === 'user') row.content = userMessagePlaceholder;
    if (e.kind === 'assistant') row.content = e.text;
    if (e.kind === 'tool_use') Object.assign(row, { tool: e.tool, call_id: e.callId, input: e.input });
    if (e.kind === 'tool_result') Object.assign(row, { call_id: e.callId, output: e.output, output_truncated: e.truncated });
    await this.request('POST', `/api/daemon/tasks/${a.taskId}/messages`, { messages: [row] });
    a.seq = row.seq; b.rows++;
    if (e.kind === 'assistant') { a.latest = e.text; if (e.final) a.final = e.text; }
  }
  async tick(b) {
    if (b.protocol !== 'windows-v1') return;
    if (blocked(this.c, b.id)) return;
    if (b.paused) return;
    if (b.retryAt && Date.now() < b.retryAt) return;
    this.currentBinding = b;
    try {
      if (!b.enabled) {
        b.pending = []; if (b.source && readWindowRecords(b, this.c)) this.save(b); return;
      }
      if (b.clientSuspended && (b.enabled || b.active || b.pending.length)) await this.resumeAfterClient(b);
      const task = taskForThread(this.c, b.id), options = { ...this.c, resources: task?.resources };
      if (task && b.taskKey !== task.key) {
        if (!b.profileKey) assignProfile(this.c, b, task.profileKey, task.profileVersion);
        b.taskKey = task.key; this.save(b);
      }
      if (readWindowRecords(b, options)) this.save(b);
      // Apply presentation redaction to queues persisted by earlier versions too.
      b.pending = b.pending.map(e => e.kind === 'user' ? { ...e, text: visibleUserText(e.text) } : e)
        .filter(e => e.kind !== 'user' || e.text).map(e => publicValue(e, options, options.resources));
      if (b.active) b.active = publicValue(b.active, options, options.resources);
      if (!b.pending.length && !b.active && (!task || (b.linkedSession && b.linkedSession === b.remote.sessionId))) return;
      await this.ensureRemote(b);
      // Bounded work per binding keeps another selected chat responsive.
      for (let n = 0; b.pending.length && n < 40; n++) {
        checkFence(this.c, b.id);
        await this.processEvent(b, b.pending[0]); b.pending.shift(); this.save(b);
      }
      b.errors = 0; delete b.lastError; delete b.retryAt; this.save(b);
    } catch (e) {
      if (e.suspended) { this.save(b); return; }
      b.errors++; b.lastError = e.message;
      if (e.permanent || e.retryable === false || b.errors >= this.c.retryLimit || /Source changed|record exceeds/.test(e.message)) b.paused = true;
      else b.retryAt = Date.now() + Math.min(30000, 500 * 2 ** Math.min(b.errors, 6));
      this.save(b);
    } finally { this.currentBinding = null; }
  }
}
