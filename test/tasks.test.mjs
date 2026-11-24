import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareTask, updateTask, taskContext, postTaskComment, getTask, taskOptions } from '../src/tasks.mjs';
import { ensureProfiles } from '../src/profiles.mjs';
import { publicText, publicValue } from '../src/privacy.mjs';

function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-task-')); t.after(() => fs.rmSync(stateDir, { recursive: true }));
  const c = { stateDir, serverUrl: 'http://fixture', workspaceSlug: 'fixture', localWorkspaceRoot: '/Users/local/workspace' }; ensureProfiles(c); return c;
}
test('retired handoff fields are rejected rather than generating another execution prompt', async t => {
  const c = fixture(t);
  await assert.rejects(prepareTask(c, { key: 'retired', issue: { title: '诊断' }, brief: { goal: 'long handoff' } }), /Retired task handoff/);
});
test('task preparation is separate from execution input and does not dispatch an agent', async t => {
  const c = fixture(t), calls = [];
  const api = { async request(method, url, body) { if (url === '/api/me') return { id: 'owner' }; calls.push({ method, url, body }); return { id: 'issue', identifier: 'TEST-1', ...body, labels: (body?.label_ids ?? []).map(id => ({ id })) }; } };
  const args = { key: 'diagnostic', issue: { title: '诊断', description: '验收：测试通过' }, resources: [{ alias: '源码', path: '/Users/local/workspace/repo' }] };
  const first = await prepareTask(c, args, api); await prepareTask(c, args, api);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/issues');
  assert.equal(calls[0].body.priority, 'low'); assert.equal(first.attributes.priority, 'low');
  assert.equal(calls[0].body.status, 'todo'); assert.equal(calls[0].body.assignee_id, 'owner'); assert.equal(first.initialization.status, 'confirmed');
  assert.equal(calls[0].body.description, args.issue.description); assert.equal(first.firstMessage, undefined);
  assert.equal(JSON.stringify(first).includes('/Users/'), false);
  assert.equal(taskContext(c, args.key).resources[0].path, args.resources[0].path);
  assert.equal(getTask(c, args.key).execution, undefined);
  await updateTask(c, args.key, { status: 'in_review' }, api);
  assert.equal(calls.at(-1).body.suppress_run, true);
  assert.equal(calls.at(-1).body.description, undefined);
});
test('unknown task creation acknowledgement does not create duplicates on retry', async t => {
  const c = fixture(t); let attempts = 0;
  const api = { async request(method, url) { if (url === '/api/me') return { id: 'owner' }; attempts++; throw new Error('lost acknowledgement'); } };
  const args = { key: 'uncertain', issue: { title: 'test' } };
  await assert.rejects(prepareTask(c, args, api), /lost acknowledgement/);
  await assert.rejects(prepareTask(c, args, api), /outcome is unknown/);
  assert.equal(attempts, 1);
});
test('issue association suppresses agent triggers and recovers a committed comment after a lost response', async t => {
  const c = fixture(t), comments = []; let posts = 0;
  const api = { async request(method, url, body) {
    if (url === '/api/agents') return [{ id: 'one' }, { id: 'two' }];
    if (method === 'GET') return comments;
    posts++; assert.deepEqual(body.suppress_agent_ids, ['one', 'two']);
    comments.push({ id: 'comment', ...body }); throw new Error('lost comment response');
  } };
  const task = { issueId: 'issue', resources: [] };
  await assert.rejects(postTaskComment(c, api, task, 'result', 'stable-key'));
  const result = await postTaskComment(c, api, task, 'result', 'stable-key');
  assert.equal(result.id, 'comment'); assert.equal(posts, 1);
});
test('presentation filter hides local paths recursively while retaining URLs and useful relative filenames', () => {
  const c = { localWorkspaceRoot: '/Users/local/workspace' }, resources = [{ alias: '源码', path: '/Users/local/workspace/repo' }];
  const value = publicValue({ cmd: 'cat /Users/local/workspace/repo/src/file.go', out: '/Users/other/private.txt', url: 'https://example.com/docs/test', win: 'C:\\Users\\user\\repo\\main.go' }, c, resources);
  assert.equal(value.cmd, 'cat [源码]/src/file.go'); assert.equal(value.out, '[本地路径]'); assert.equal(value.url, 'https://example.com/docs/test');
  assert.equal(value.win, '[本地路径]');
  assert.equal(publicText('/Users/local/workspace/repository', c, resources), '[本地工作区]/repository');
});

test('creation initializes requested attributes and reports server mismatches without recreating', async t => {
  const c = fixture(t), calls = [];
  const api = { async request(method, url, body) { calls.push(body); return { id: 'issue-2', identifier: 'TEST-2', ...body, labels: body.label_ids.map(id => ({ id })) }; } };
  const issue = { title: '修复', status: 'in_progress', assignee_type: 'member', assignee_id: 'owner', project_id: 'project', priority: 'high', label_ids: ['label'] };
  const result = await prepareTask(c, { key: 'attributes', issue }, api);
  assert.deepEqual(result.attributes, { status: 'in_progress', priority: 'high', assignee_type: 'member', assignee_id: 'owner', project_id: 'project', label_ids: ['label'] });
  const mismatch = { async request(method, url, body) { calls.push(body); return { id: 'issue-3', identifier: 'TEST-3', ...body, status: 'todo' }; } };
  await assert.rejects(prepareTask(c, { key: 'mismatch', issue }, mismatch), /was created.*status/);
  const again = await prepareTask(c, { key: 'mismatch', issue }, mismatch);
  assert.equal(again.issueId, 'issue-3'); assert.equal(again.initialization.status, 'mismatch'); assert.equal(calls.length, 2);
});
test('definite validation rejection can be corrected while uncertain creation remains fenced', async t => {
  const c = fixture(t); let calls = 0;
  const api = { async request(method, url, body) { calls++; if (calls === 1) throw Object.assign(new Error('invalid label_ids'), { status: 400 }); return { id: 'fixed', identifier: 'TEST-4', ...body, labels: [] }; } };
  const args = { key: 'corrected', issue: { title: 'test', assignee_id: 'owner' } };
  await assert.rejects(prepareTask(c, args, api), /invalid label_ids/);
  assert.equal((await prepareTask(c, args, api)).initialization.status, 'confirmed');
  await assert.rejects(prepareTask(c, { key: 'agent', issue: { title: 'test', assignee_type: 'agent' } }, api), /Only human/);
});
test('member options expose user ids without email or other private profile data', async t => {
  const result = await taskOptions(fixture(t), 'members', { async request() { return [{ id: 'membership', user_id: 'user', name: 'Name', email: 'private@example.com', role: 'member' }]; } });
  assert.deepEqual(result.items, [{ user_id: 'user', name: 'Name', role: 'member' }]);
});

test('automatic state choices stop at review; done and other states require a user instruction', async t => {
  const c = fixture(t), calls = [];
  const api = { async request(method, url, body) { calls.push({ method, body }); return { id: 'issue', identifier: 'TEST-5', ...body, labels: [] }; } };
  await prepareTask(c, { key: 'state', issue: { title: 'test', assignee_id: 'owner' } }, api);
  for (const status of ['in_progress', 'in_review']) await updateTask(c, 'state', { status }, api);
  const count = calls.length;
  for (const status of ['done', 'cancelled', 'blocked', 'todo']) await assert.rejects(updateTask(c, 'state', { status }, api), /explicit user instruction/);
  assert.equal(calls.length, count);
  await updateTask(c, 'state', { status: 'done' }, api, { statusSource: 'user_requested' });
  assert.equal(calls.at(-1).body.status, 'done'); assert.equal(calls.at(-1).body.suppress_run, true);
  await assert.rejects(prepareTask(c, { key: 'auto-done', issue: { title: 'test', status: 'done', assignee_id: 'owner' } }, api), /explicit user instruction/);
});

test('child tasks retain an explicit parent, inherit project only, and remain independently editable', async t => {
  const c = fixture(t), calls = [];
  const parent = { id: 'parent-id', identifier: 'TEST-P', project_id: 'project', parent_issue_id: null };
  const api = { async request(method, url, body) {
    calls.push({method,url,body});
    if (url === '/api/me') return { id: 'owner' };
    if (url === '/api/issues/parent-id') return parent;
    if (method === 'POST') return { id: 'child-id', identifier: 'TEST-C', ...body, labels: body.label_ids.map(id => ({ id })) };
    return { id: 'child-id', parent_issue_id: parent.id };
  } };
  await prepareTask(c, { key: 'parent', issue_id: parent.id }, api);
  const child = await prepareTask(c, { key: 'child', parent_key: 'parent', issue: { title: '子任务', description: '## 摘要\n处理一个部分', label_ids: ['chosen-label'] } }, api);
  assert.equal(child.parentKey, 'parent'); assert.equal(child.parentIssueId, parent.id); assert.equal(child.syncTarget, 'parent_only');
  assert.equal(child.attributes.project_id, parent.project_id); assert.equal(child.initialization.status, 'confirmed');
  const post = calls.find(c => c.method === 'POST');
  assert.equal(post.body.parent_issue_id, parent.id); assert.equal(post.body.assignee_type, 'member');
  assert.deepEqual(post.body.label_ids, ['chosen-label']); assert.equal(post.body.priority, 'low');
  await updateTask(c, 'child', { status: 'in_review' }, api);
  assert.equal(calls.at(-1).url, '/api/issues/child-id'); assert.equal(calls.at(-1).body.suppress_run, true);
  const count = calls.length; await prepareTask(c, { key: 'child', parent_key: 'parent', issue: { title: 'retry' } }, api); assert.equal(calls.length, count);
  await assert.rejects(prepareTask(c, { key: 'child', parent_key: 'other', issue: { title: 'bad' } }, api), /different parent/);
  await assert.rejects(prepareTask(c, { key: 'parent', parent_key: 'parent', issue: { title: 'bad' } }, api), /different parent/);
});
test('wrong remote parent is reported as a committed mismatch and never recreated', async t => {
  const c = fixture(t);
  const api = { async request(method, url, body) {
    if (method === 'GET') return { id: 'parent', project_id: null };
    return { id: 'child', identifier: 'TEST-C', ...body, parent_issue_id: 'wrong', labels: [] };
  } };
  await prepareTask(c, { key: 'parent', issue_id: 'parent' }, api);
  await assert.rejects(prepareTask(c, { key: 'bad-child', parent_key: 'parent', issue: { title: 'child', assignee_id: 'owner' } }, api), /was created.*parent_issue_id/);
  assert.equal(getTask(c,'bad-child').issueId, 'child');
});

test('project label hints use deployment configuration rather than a hard-coded naming convention', async t => {
  const c = { ...fixture(t), projectLabelPrefix: 'Project-' };
  const result = await taskOptions(c, 'labels', { async request() { return { labels: [{id:'one',name:'Project-Example',description:'project',resource_type:'issue'}, {id:'two',name:'BugFix',resource_type:'issue'}] }; } });
  assert.deepEqual(result.suggestedProjectLabels, [{ id: 'one', name: 'Project-Example' }]);
  assert.equal(result.items.length, 2);
});
