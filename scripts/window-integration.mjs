// Real development API + independent MCP and daemon; synthetic transcripts only.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig, projectDir } from '../src/config.mjs';
import { API, list } from '../src/api.mjs';
import { ensureProfiles, saveProfile } from '../src/profiles.mjs';
import { readJson, writeJson } from '../src/storage.mjs';

const base = loadConfig(), dir = process.env.MULTICA_BRIDGE_TEST_DIR;
if (base.environment === 'production' || !process.argv.includes('--development') || process.argv[process.argv.indexOf('--server-confirm') + 1] !== base.serverUrl) throw new Error('Confirm a development target.');
if (!dir || !path.isAbsolute(dir)) throw new Error('An absolute test directory is required.');
const c = { ...base, stateDir: path.join(dir, 'state'), codexHome: path.join(dir, 'codex'), autoDiscover: false, clientPresence: { enabled: false } };
fs.mkdirSync(path.join(c.codexHome, 'sessions'), { recursive: true });
const config = path.join(dir, 'config.json'); writeJson(config, c); ensureProfiles(c);
const suffix = randomUUID().slice(0, 8), key = 'window-test-' + suffix, profile = 'window-' + suffix, id = randomUUID();
saveProfile(c, profile, { name: '合成窗口测试 ' + suffix });
const source = path.join(c.codexHome, 'sessions', id + '.jsonl'); fs.writeFileSync(source, '');
const db = new DatabaseSync(path.join(c.codexHome, 'state_5.sqlite'));
db.exec('CREATE TABLE threads(id TEXT,cwd TEXT,rollout_path TEXT,source TEXT,thread_source TEXT)');
db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run(id, '/synthetic/ordinary-workspace', source, 'vscode', 'agent_created_thread'); db.close();
const append = (type, payload) => fs.appendFileSync(source, JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + '\n');
const begin = turn => append('event_msg', { type: 'task_started', turn_id: turn });
const answer = (text, turn) => append('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', internal_chat_message_metadata_passthrough: { turn_id: turn }, content: [{ type: 'output_text', text }] });
const end = turn => append('event_msg', { type: 'task_complete', turn_id: turn });
const transport = new StdioClientTransport({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', path.join(projectDir, 'src/mcp.mjs')], env: { ...process.env, MULTICA_BRIDGE_CONFIG: config }, stderr: 'pipe' });
const client = new Client({ name: 'window-integration', version: '1' }); let task, child, holder, sessionId, report;
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content.find(c => c.type === 'text').text);
}
async function confirmed(name, args) {
  let r = await call(name, args);
  for (let n = 0; r.status === 'pending' && n < 20; n++) { await new Promise(r => setTimeout(r, 500)); r = await call('get_operation', { request_id: r.requestId }); }
  assert.equal(r.status, 'confirmed', JSON.stringify(r)); return r;
}
async function drain(turns) {
  for (let n = 0; n < 100; n++) {
    const s = await call('get_sync_status', { thread_id: id });
    if (s.lastError) throw new Error(s.lastError);
    if (s.turns >= turns && !s.activeTaskId && !s.queuedEvents) return s;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Timed out draining synthetic output.');
}
const api = new API(c);
try {
  await client.connect(transport);
  begin('old'); answer('PRIVATE_BEFORE_CONNECT', 'old');
  const options = await call('get_task_options', { kind: 'statuses' });
  assert.ok(options.items.some(s => s.key === 'todo'));
  task = await call('prepare_task', { key, profile_key: profile, issue: { title: '合成窗口测试 ' + suffix, description: '## 摘要\n合成脱敏验证 password=TASK_SYNTHETIC_SECRET' }, publish_results: false });
  assert.equal(task.firstMessage, undefined);
  assert.equal(task.initialization.status, 'confirmed');
  assert.equal(task.attributes.assignee_type, 'member');
  assert.ok(task.attributes.assignee_id);
  child = await call('prepare_task', { key: key + '-child', parent_key: key, issue: { title: '合成子任务 ' + suffix, description: '## 摘要\n验证父任务统一同步和子任务独立状态。' } });
  assert.equal(child.parentIssueId, task.issueId);
  assert.equal(child.initialization.status, 'confirmed');
  const rejected = await client.callTool({ name: 'connect_current', arguments: { thread_id: id, key: key + '-child' } });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /parent task/);
  assert.equal((await call('get_task', { key })).children[0].key, key + '-child');
  await call('update_task', { key: key + '-child', fields: { status: 'in_progress' } });
  holder = await call('prepare_task', { key: key + '-holder', issue: { title: '合成父级校验容器 ' + suffix } });
  async function reparent(parentId) {
    const current = await api.request('GET', `/api/issues/${task.issueId}`);
    await api.request('PUT', `/api/issues/${task.issueId}`, { parent_issue_id: parentId, expected_revision: current.revision, suppress_run: true });
  }
  async function rejectedControl(name, args) {
    let result = await call(name, args);
    for (let n = 0; result.status === 'pending' && n < 30; n++) { await new Promise(r => setTimeout(r, 200)); result = await call('get_operation', { request_id: result.requestId }); }
    assert.equal(result.status, 'failed'); assert.match(result.error, /child/); return result;
  }
  await reparent(holder.issueId);
  await rejectedControl('connect_current', { thread_id: id, key });
  assert.equal(fs.existsSync(path.join(c.stateDir, 'task-bindings', id + '.json')), false);
  assert.equal((await call('get_sync_status', { thread_id: id })).enabled, false);
  await reparent(null);
  const connected = await confirmed('connect_current', { thread_id: id, key }); sessionId = connected.result.sessionId;
  append('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE_USER_INPUT' }] });
  append('response_item', { type: 'function_call', call_id: 'privacy-probe', name: 'synthetic_tool', arguments: JSON.stringify({ password: 'INPUT_SYNTHETIC_SECRET' }) });
  append('response_item', { type: 'function_call_output', call_id: 'privacy-probe', output: JSON.stringify({ nested: { apiKey: 'OUTPUT_SYNTHETIC_SECRET' }, safe: 'kept' }) });
  answer('public output one password=ANSWER_SYNTHETIC_SECRET', 'old'); end('old'); await drain(1);
  const paused = await confirmed('pause_sync', { thread_id: id, expected_generation: 1 }); assert.equal(paused.result.localStopped, true);
  // A cached v0.4 MCP process must not be able to reopen a v0.5 private window.
  const legacyCommand = path.join(c.stateDir, 'bindings', id + '.json.command'); writeJson(legacyCommand, { action: 'resume' });
  for (let n = 0; n < 30 && fs.existsSync(legacyCommand); n++) await new Promise(r => setTimeout(r, 100));
  assert.equal(fs.existsSync(legacyCommand), false);
  assert.equal((await call('get_sync_status', { thread_id: id })).enabled, false);
  begin('private'); answer('PRIVATE_WHILE_PAUSED', 'private'); end('private');
  await reparent(holder.issueId);
  await rejectedControl('resume_sync', { thread_id: id, expected_generation: 2 });
  assert.equal((await call('get_sync_status', { thread_id: id })).enabled, false);
  await reparent(null);
  const resumed = await confirmed('resume_sync', { thread_id: id, expected_generation: 2 }); assert.equal(resumed.result.sessionId, sessionId);
  begin('public'); answer('public output two', 'public'); end('public'); await drain(2);
  const verified = await call('get_sync_status', { thread_id: id, verify_remote: true }); assert.equal(verified.remote.assistantMessages, 2);
  const messages = list(await api.request('GET', `/api/chat/sessions/${sessionId}/messages`), 'messages');
  assert.equal(messages.filter(m => m.role === 'user').length, 2);
  assert.ok(messages.filter(m => m.role === 'user').every(m => m.content === '用户消息'));
  assert.equal(JSON.stringify(messages).includes('PRIVATE_'), false);
  const registry = readJson(path.join(c.stateDir, 'remote-registry.json')), agentId = registry.agents[profile].id;
  const tasks = list(await api.request('GET', `/api/agents/${agentId}/tasks?limit=200`), 'tasks');
  assert.equal(tasks.length, 2); assert.ok(tasks.every(t => t.chat_session_id === sessionId && t.status === 'completed'));
  await call('update_task', { key: key + '-child', fields: { status: 'in_review' } });
  const childIssue = await api.request('GET', `/api/issues/${child.issueId}`);
  assert.equal(childIssue.status, 'in_review'); assert.equal(childIssue.parent_issue_id, task.issueId);
  assert.ok(tasks.every(t => t.issue_id !== child.issueId));
  assert.equal((await call('get_task', { key: key + '-child' })).bindings.length, 0);
  const issue = await api.request('GET', `/api/issues/${task.issueId}`); assert.equal(issue.status, 'todo');
  assert.equal(issue.description.includes('TASK_SYNTHETIC_SECRET'), false);
  assert.equal(JSON.stringify(messages).includes('ANSWER_SYNTHETIC_SECRET'), false);
  for (const run of tasks) {
    const transcript = await api.request('GET', `/api/tasks/${run.id}/messages`);
    assert.equal(/(?:INPUT|OUTPUT|ANSWER)_SYNTHETIC_SECRET/.test(JSON.stringify(transcript)), false);
  }
  await confirmed('pause_sync', { thread_id: id });
  report = { success: true, version: readJson(path.join(projectDir, 'package.json')).version, issueId: task.issueId, sessionId, agentId, runtimeId: registry.runtimeId,
    outboundPrivacyVerified: true, parentValidationRegressionsVerified: true, holderIssueId: holder.issueId, subtasksVerified: true, childIssueId: child.issueId, mcpAndDaemonConfirmed: true, sameChatOnResume: true, privateWindowsNotSent: true, userInputMasked: true, modelInvocations: 0, timestamp: new Date().toISOString() };
  writeJson(path.join(dir, 'result.json'), report); console.log(JSON.stringify(report));
} finally {
  fs.writeFileSync(path.join(c.stateDir, 'stop'), 'stop\n', { mode: 0o600 });
  await client.close();
  for (let n = 0; n < 80 && fs.existsSync(path.join(c.stateDir, 'daemon.lock')); n++) await new Promise(r => setTimeout(r, 200));
  const registry = readJson(path.join(c.stateDir, 'remote-registry.json'), {});
  writeJson(path.join(dir, 'cleanup-manifest.json'), { issueId: task?.issueId, childIssueId: child?.issueId, holderIssueId: holder?.issueId, sessionId, runtimeId: registry.runtimeId, agentId: registry.agents?.[profile]?.id });
}
