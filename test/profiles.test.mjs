import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureProfiles, saveProfile, getProfile, assignProfile, configurationStatus, setDefaultProfile, getDefaultProfile } from '../src/profiles.mjs';
import { Registry } from '../src/registry.mjs';

function config(t) { const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-profiles-')); t.after(() => fs.rmSync(stateDir, { recursive: true })); const c = { stateDir, workspaceId: 'workspace', retryLimit: 10 }; ensureProfiles(c); return c; }
test('saved versions do not silently alter a bound execution configuration', t => {
  const c = config(t); const p = saveProfile(c, 'review', { name: '审查', instructions: '检查边界', model: 'model-a', effort: 'high' });
  setDefaultProfile(c, 'review'); assert.equal(getDefaultProfile(c).key, 'review');
  const b = { remote: {} }; assignProfile(c, b, 'review');
  const changed = saveProfile(c, 'review', { instructions: '检查回归', model: 'model-b' }, p.version);
  assert.equal(changed.version, 2); assert.equal(getProfile(c, 'review', 1).settings.instructions, '检查边界');
  assert.throws(() => saveProfile(c, 'review', { name: 'overwrite' }, 1), /version changed/);
  assert.equal(configurationStatus(c, b).boundVersion, 1); assert.equal(configurationStatus(c, b).updateAvailable, true);
  b.observed = { model: 'model-a', effort: 'high' }; assert.equal(configurationStatus(c, b).model.status, 'match');
  assignProfile(c, b, 'review', 2); const status = configurationStatus(c, b);
  assert.equal(status.model.status, 'mismatch');
  b.remote = { sessionId: 'existing' }; assert.throws(() => assignProfile(c, b, 'general'), /keeps its mirror identity/);
});
test('same profile reuses the agent across sessions and versions; all profiles share one runtime', async t => {
  const c = config(t); let registered = 0, created = 0, updates = 0;
  const api = { async request(method, url) {
    if (url.endsWith('/register')) { registered++; return { runtimes: [{ id: 'shared-runtime' }] }; }
    if (url.endsWith('/heartbeat')) return {};
    if (url === '/api/agents' && method === 'GET') return [];
    if (url === '/api/agents' && method === 'POST') return { id: 'agent-' + (++created) };
    if (method === 'PUT') { updates++; return {}; }
    throw new Error('Unexpected API ' + url);
  } };
  const registry = new Registry(c, api);
  const first = await registry.ensureAgent('general'), second = await registry.ensureAgent('general');
  assert.equal(first, second); assert.equal(registered, 1); assert.equal(created, 1);
  saveProfile(c, 'general', { instructions: 'New behavior' }, 1); assert.equal(await registry.ensureAgent('general'), first);
  assert.equal(created, 1); assert.equal(updates, 2);
  saveProfile(c, 'review', { name: '审查' }); await registry.ensureAgent('review');
  assert.equal(registered, 1); assert.equal(created, 2);
  const resumed = new Registry(c, api); assert.equal(await resumed.ensureAgent('general'), first); assert.equal(created, 2);
});
