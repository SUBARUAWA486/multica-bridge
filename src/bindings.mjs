import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { configPaths } from './config.mjs';
import { readJson, writeJson } from './storage.mjs';
import { threadMetadata } from './source.mjs';
import { ensureProfiles, getDefaultProfile, assignProfile, configurationStatus } from './profiles.mjs';

export function bindingFile(c, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid thread ID.');
  return path.join(configPaths(c).bindings, id + '.json');
}
export function getBindings(c) {
  const dir = configPaths(c).bindings;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => readJson(path.join(dir, f)));
}
export function bind(c, id, { profileKey } = {}) {
  const file = bindingFile(c, id), existing = readJson(file, null);
  if (existing) return existing;
  const meta = threadMetadata(c, id), stat = fs.statSync(meta.source);
  const b = { version: 1, id, ...meta, enabled: true, boundAt: new Date().toISOString(), inode: stat.ino,
    protocol: 'windows-v1', offset: stat.size, pending: [], turnId: `attach-${randomUUID()}`,
    remote: {}, active: null, errors: 0, rows: 0, turns: 0 };
  ensureProfiles(c); const profile = getDefaultProfile(c); assignProfile(c, b, profileKey ?? profile.key);
  writeJson(file, b); return b;
}
export function retireBinding(c, b) {
  if (b.protocol === 'windows-v1' || b.protocol === 'retired') return false;
  if (b.active) b.unsettledActive = b.active;
  b.active = null; b.pending = []; b.enabled = false; b.paused = false;
  b.protocol = 'retired'; b.syncMode = 'paused'; b.retiredAt = new Date().toISOString();
  delete b.nextProfile; delete b.instructionsLoadedVersion; delete b.retryAt; delete b.lastError;
  writeJson(bindingFile(c, b.id), b); return true;
}
export function summary(c, b) {
  return { threadId: b.id, cwd: b.cwd, enabled: b.enabled, paused: b.paused ?? false,
    protocol: b.protocol ?? 'legacy', generation: b.generation ?? 0, syncMode: b.syncMode,
    sourceReadAt: b.sourceReadAt, lastServerAckAt: b.lastServerAckAt, filteredEvents: b.filteredEvents ?? 0,
    queuedEvents: b.pending.length, rows: b.rows, turns: b.turns, activeTaskId: b.active?.taskId,
    status: b.lastError ? 'attention' : b.clientSuspended ? 'waiting_for_multica' : b.active ? 'syncing' : 'idle', lastError: b.lastError,
    interrupted: b.interrupted,
    configuration: configurationStatus(c, b),
    sessionId: b.remote.sessionId, url: b.remote.sessionId ? `${c.serverUrl}/${c.workspaceSlug}/chat?session=${b.remote.sessionId}` : undefined };
}
