import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { configPaths, projectDir, configFile } from './config.mjs';
import { readJson, writeJson } from './storage.mjs';
import { bindingFile, getBindings, summary } from './bindings.mjs';
import { ensureProfiles, listProfiles, getProfile, saveProfile, setDefaultProfile } from './profiles.mjs';
import { getTask, taskForThread, taskSummary, prepareTask } from './tasks.mjs';
import { API, list } from './api.mjs';
import { submit, waitOperation, operation } from './operations.mjs';
import { blocked } from './fences.mjs';

export function status(c) {
  const health = readJson(configPaths(c).health, null);
  const registry = readJson(path.join(c.stateDir, 'remote-registry.json'), {});
  return { serverUrl: c.serverUrl, workspace: c.workspaceSlug,
    apiAccess: { projectDir, configFile, clientModule: path.join(projectDir, 'src/api.mjs'), guidance: '使用 loadConfig() + new API(config).request(method, endpoint, body)；凭据由 API 内部加载，勿打印。MCP 缺少功能不需要申请应用控制权限。' },
    mode: 'current_chat', strictSyncControlsAvailable: true,
    defaultProfile: readJson(path.join(c.stateDir, 'settings.json'), {}).defaultProfile ?? c.defaultProfile ?? 'general', sharedRuntimeId: registry.runtimeId, registryError: registry.lastError ?? null,
    profiles: listProfiles(c).map(p => ({ key: p.key, name: p.versions.at(-1).settings.name, version: p.versions.at(-1).version, remote: registry.agents?.[p.key] })),
    autoDiscover: c.autoDiscover, toolPayloads: c.toolPayloads,
    followMultica: Boolean(c.clientPresence?.enabled), closedContentPolicy: c.clientPresence?.enabled ? 'skip' : null,
    daemon: health ? { ...health, fresh: Date.now() - Date.parse(health.at) < 20000 } : { running: false },
    bindings: getBindings(c).map(b => summary(c, b)) };
}
export async function syncControl(c, args) {
  if (args.issue) await prepareTask(c, { key: args.key, issue: args.issue, status_source: args.status_source, resources: args.resources, publish_results: args.publish_results });
  const op = submit(c, args); start(c);
  return waitOperation(c, op.requestId);
}
export async function syncStatus(c, id, verifyRemote = false) {
  const b = readJson(bindingFile(c, id)), t = taskForThread(c, id);
  const result = { ...summary(c, b), cwd: undefined, task: t ? taskSummary(t) : null, controlPending: blocked(c, id) };
  if (verifyRemote && b.remote.sessionId) {
    const api = new API(c), session = await api.request('GET', `/api/chat/sessions/${b.remote.sessionId}`);
    const messages = list(await api.request('GET', `/api/chat/sessions/${b.remote.sessionId}/messages`), 'messages');
    result.remote = { sessionId: session.id, title: session.title, userMessages: messages.filter(m => m.role === 'user').length,
      assistantMessages: messages.filter(m => m.role === 'assistant').length, apiVerifiedAt: new Date().toISOString(), clientDisplayVerified: false };
  }
  return result;
}
export async function taskStatus(c, key) {
  const task = getTask(c, key);
  const issue = await new API(c).request('GET', `/api/issues/${task.issueId}`);
  const children = list(await new API(c).request('GET', `/api/issues/${task.issueId}/children`), 'issues');
  const localKeys = new Map();
  for (const name of fs.readdirSync(path.join(c.stateDir, 'tasks')).filter(n => n.endsWith('.json'))) {
    const local = readJson(path.join(c.stateDir, 'tasks', name)); if (local.issueId) localKeys.set(local.issueId, local.key);
  }
  return { ...taskSummary(task), children: children.map(i => ({ key: localKeys.get(i.id), id: i.id, identifier: i.identifier, title: i.title, status: i.status, priority: i.priority, labels: i.labels })), issue: { id: issue.id, parent_issue_id: issue.parent_issue_id, identifier: issue.identifier, title: issue.title, status: issue.status, priority: issue.priority, project_id: issue.project_id, assignee_type: issue.assignee_type, assignee_id: issue.assignee_id, labels: issue.labels },
    bindings: getBindings(c).filter(b => taskForThread(c, b.id)?.key === key).map(b => ({ ...summary(c, b), linked: b.linkedSession === b.remote.sessionId && Boolean(b.linkedSession) })) };
}
export function start(c) {
  const p = configPaths(c);
  if (fs.existsSync(p.lock)) {
    const pid = Number(fs.readFileSync(p.lock, 'utf8'));
    try { process.kill(pid, 0); return { pid, alreadyRunning: true }; } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  fs.mkdirSync(c.stateDir, { recursive: true, mode: 0o700 }); fs.rmSync(p.stop, { force: true });
  const log = fs.openSync(p.log, 'a', 0o600);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(projectDir, 'src/daemon.mjs')], {
    cwd: projectDir, detached: true, stdio: ['ignore', log, log], env: { ...process.env } });
  fs.closeSync(log); child.unref(); return { pid: child.pid, started: true };
}
export function manageProfile(c, key, values, expectedVersion, makeDefault = false) {
  ensureProfiles(c); const profile = saveProfile(c, key, values, expectedVersion);
  if (makeDefault) setDefaultProfile(c, key);
  fs.writeFileSync(path.join(c.stateDir, 'sync-profiles'), 'sync\n', { mode: 0o600 });
  return { profile, projection: 'pending; inspect get_status', daemon: start(c), appliesToExistingCodex: false };
}
