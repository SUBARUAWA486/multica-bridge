import path from 'node:path';
import fs from 'node:fs';
import { API, list } from './api.mjs';
import { readJson, writeJson, acquireLock } from './storage.mjs';
import { getProfile } from './profiles.mjs';
import { publicText, validateResources } from './privacy.mjs';

export function taskFile(c, key) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key)) throw new Error('Invalid task key.');
  return path.join(c.stateDir, 'tasks', key + '.json');
}
export function getTask(c, key) { return readJson(taskFile(c, key)); }
export function taskSummary(t) {
  // Allowlist: older persisted records may still contain large handoff prompts,
  // resource paths, execution policies and role-loading instructions.
  return { key: t.key, issueId: t.issueId, identifier: t.identifier, issueUrl: t.issueUrl,
    title: t.title, parentKey: t.parentKey, parentIssueId: t.parentIssueId ?? null, syncTarget: t.parentIssueId ? 'parent_only' : 'self', attributes: t.attributes, initialization: t.initialization,
    profileKey: t.profileKey, profileVersion: t.profileVersion, publishResults: t.publishResults,
    createdAt: t.createdAt, resources: (t.resources ?? []).map(r => ({ alias: r.alias, purpose: r.purpose })) };
}
function checkStatus(status, source = 'automatic', creating = false) {
  if (!['automatic', 'user_requested'].includes(source)) throw new Error('Invalid status_source.');
  if (status !== undefined && !['in_progress', 'in_review', ...(creating ? ['todo'] : [])].includes(status) && source !== 'user_requested') throw new Error('Status requires an explicit user instruction. Models may only choose in_progress or in_review; work completion means in_review, never done.');
}
const attributeKeys = ['status', 'priority', 'assignee_type', 'assignee_id', 'project_id'];
function attributes(issue) {
  return { ...Object.fromEntries(attributeKeys.map(k => [k, issue[k] ?? null])),
    label_ids: (issue.labels ?? []).map(l => l.id).sort() };
}
export async function taskOptions(c, kind, api = new API(c)) {
  const routes = { statuses: ['/api/issue-statuses', 'statuses', ['id', 'key', 'name', 'category', 'archived_at']],
    projects: ['/api/projects', 'projects', ['id', 'title', 'identifier', 'workflow_id', 'archived_at']],
    labels: ['/api/labels?resource_type=issue', 'labels', ['id', 'name', 'description', 'resource_type']],
    members: [`/api/workspaces/${c.workspaceId}/members`, 'members', ['user_id', 'name', 'role']] };
  if (!routes[kind]) throw new Error('Unknown task option kind.');
  const [url, key, keys] = routes[kind], result = await api.request('GET', url);
  const prefix = c.projectLabelPrefix;
  const suggestedProjectLabels = kind === 'labels' && prefix ? list(result, key).filter(row => row.name?.startsWith(prefix)).map(row => ({ id: row.id, name: row.name })) : undefined;
  return { kind, suggestedProjectLabels, total: result?.total, has_more: result?.has_more ?? false, items: list(result, key).map(row => Object.fromEntries(keys.filter(k => row[k] !== undefined).map(k => [k, row[k]]))),
    guidance: '使用实际 ID/状态 key；项目工作流可能限制可用状态，由创建接口最终校验。不要用成员记录 id 代替 user_id。' };
}
export function taskContext(c, key) {
  const t = getTask(c, key);
  return { key, resources: t.resources ?? [], guidance: '仅按需读取的本机资源映射，不复述到远端。当前聊天继续工作，无需重新加载任务指令。' };
}
export async function prepareTask(c, a, api = new API(c)) {
  for (const field of ['brief', 'first_message', 'execution']) if (a[field] !== undefined) throw new Error(`Retired task handoff field: ${field}. Use issue title and an optional concise description in the current chat.`);
  const file = taskFile(c, a.key), release = acquireLock(file + '.lock');
  try {
    const existing = readJson(file, null);
    if (existing) {
      if (a.parent_key !== undefined && a.parent_key !== existing.parentKey) throw new Error('Task key already belongs to a different parent; use the original key without changing its relationship.');
      if (!existing.issueId) {
        if (!a.issue_id) throw new Error('Issue creation outcome is unknown; inspect Multica and reconcile explicitly with issue_id instead of creating a duplicate.');
        const issue = await api.request('GET', `/api/issues/${a.issue_id}`);
        if (existing.parentIssueId && issue.parent_issue_id !== existing.parentIssueId) throw new Error('Recovered issue does not belong to the expected parent.');
        existing.parentIssueId = issue.parent_issue_id ?? null; existing.attributes = attributes(issue);
        existing.issueId = issue.id; existing.identifier = issue.identifier;
        existing.issueUrl = `${c.serverUrl}/${c.workspaceSlug}/issues/${issue.identifier}`;
        delete existing.creationAttempted; writeJson(file, existing);
      }
      return taskSummary(existing);
    }
    if (Boolean(a.issue_id) === Boolean(a.issue)) throw new Error('Provide exactly one of issue_id or issue.');
    if (a.parent_key && a.issue_id) throw new Error('parent_key is for creating a child; associate existing children using issue_id without reparenting.');
    if (a.parent_key === a.key) throw new Error('A task cannot be its own parent.');
    let parent;
    if (a.parent_key) {
      const local = getTask(c, a.parent_key);
      if (!local.issueId) throw new Error('Parent creation is not confirmed.');
      parent = await api.request('GET', `/api/issues/${local.issueId}`);
      if (parent.parent_issue_id) throw new Error('Use a top-level parent task; nested child groups are not supported.');
    }
    const resources = validateResources(a.resources ?? []), profileKey = a.profile_key ?? 'general';
    const profile = getProfile(c, profileKey);
    const t = { key: a.key, parentKey: a.parent_key, parentIssueId: parent?.id ?? null, resources, profileKey, profileVersion: profile.version, publishResults: a.publish_results ?? false, createdAt: new Date().toISOString() };
    if (a.issue_id) {
      const issue = await api.request('GET', `/api/issues/${a.issue_id}`);
      t.issueId = issue.id; t.identifier = issue.identifier; t.title = issue.title;
      t.parentIssueId = issue.parent_issue_id ?? null;
    } else {
      checkStatus(a.issue.status, a.status_source, true);
      if (a.issue.assignee_type && a.issue.assignee_type !== 'member') throw new Error('Only human task owners are supported; agent assignment can start a second execution.');
      if (a.issue.assignee_id === null || a.issue.assignee_type === null) throw new Error('Create requires a human owner to prevent workflow auto-assignment; omit owner to use the current user.');
      const owner = a.issue.assignee_id ?? (await api.request('GET', '/api/me')).id;
      if (!owner) throw new Error('Cannot resolve the current task owner; provide assignee_id explicitly.');
      const body = { title: publicText(a.issue.title, c, resources), description: publicText(a.issue.description ?? '', c, resources),
        project_id: a.issue.project_id ?? parent?.project_id ?? null, priority: a.issue.priority ?? 'low', label_ids: a.issue.label_ids ?? [],
        assignee_type: 'member', assignee_id: owner, status: a.issue.status ?? 'todo', pr_auto_complete_disabled: true };
      if (parent) body.parent_issue_id = parent.id;
      writeJson(file, { ...t, creationAttempted: true });
      let issue;
      try { issue = await api.request('POST', '/api/issues', body); }
      catch (e) {
        // A definite rejection did not create an issue. Keep unknown outcomes fenced.
        if (e.requestDelivery === 'not_sent' || [400, 401, 403, 404, 405, 409, 422].includes(e.status)) {
          fs.unlinkSync(file);
        }
        throw e;
      }
      t.issueId = issue.id; t.identifier = issue.identifier; t.title = issue.title;
      t.attributes = attributes(issue);
      const expected = { ...Object.fromEntries(attributeKeys.map(k => [k, body[k]])), label_ids: [...body.label_ids].sort() };
      t.parentIssueId = issue.parent_issue_id ?? null;
      const mismatches = Object.keys(expected).filter(k => JSON.stringify(expected[k]) !== JSON.stringify(t.attributes[k]));
      if (parent && issue.parent_issue_id !== parent.id) mismatches.push('parent_issue_id');
      t.initialization = { status: mismatches.length ? 'mismatch' : 'confirmed', mismatched_fields: mismatches,
        warnings: [...(!body.project_id ? ['未设置项目'] : []), ...(!body.label_ids.length ? ['未设置标签'] : [])] };
    }
    t.issueUrl = `${c.serverUrl}/${c.workspaceSlug}/issues/${t.identifier}`;
    writeJson(file, t);
    if (t.initialization?.status === 'mismatch') throw new Error(`Task ${t.identifier} (${t.issueId}) was created, but attributes were not confirmed: ${t.initialization.mismatched_fields.join(', ')}. Do not recreate; inspect this task.`);
    return taskSummary(t);
  } finally { release(); }
}
export async function updateTask(c, key, fields, api = new API(c), options = {}) {
  checkStatus(fields.status, options.statusSource);
  if (Object.keys(fields).some(k => !['title', 'description', 'status', 'priority', 'project_id'].includes(k))) throw new Error('Unsupported task field. Agent assignment and execution input are separate operations.');
  const t = getTask(c, key), current = await api.request('GET', `/api/issues/${t.issueId}`);
  const body = { ...fields, suppress_run: true };
  if (current.revision !== undefined) body.expected_revision = current.revision;
  if (body.title !== undefined) { body.title_base = current.title; body.title = publicText(body.title, c, t.resources); }
  if (body.description !== undefined) { body.description_base = current.description; body.description = publicText(body.description, c, t.resources); }
  return api.request('PUT', `/api/issues/${t.issueId}`, body);
}
export function threadTaskFile(c, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid thread ID.');
  return path.join(c.stateDir, 'task-bindings', id + '.json');
}
export function taskForThread(c, id) {
  const ref = readJson(threadTaskFile(c, id), null);
  return ref ? getTask(c, ref.key) : null;
}
export async function postTaskComment(c, api, task, content, markerKey) {
  const marker = `<!-- multica-bridge:${markerKey} -->`;
  const existing = list(await api.request('GET', `/api/issues/${task.issueId}/comments`), 'comments');
  const found = existing.find(x => x.content?.includes(marker));
  if (found) return found;
  const agents = list(await api.request('GET', '/api/agents'), 'agents');
  return api.request('POST', `/api/issues/${task.issueId}/comments`, {
    content: publicText(content, c, task.resources) + '\n\n' + marker,
    type: 'comment', suppress_agent_ids: agents.map(x => x.id)
  });
}
