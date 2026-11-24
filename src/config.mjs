import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readJson } from './storage.mjs';

export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const configFile = process.env.MULTICA_BRIDGE_CONFIG || path.join(projectDir, 'config.local.json');
export function loadConfig() {
  const c = readJson(configFile);
  for (const k of ['serverUrl', 'workspaceId', 'workspaceSlug', 'profilePath', 'stateDir', 'codexHome']) {
    if (typeof c[k] !== 'string' || !c[k]) throw new Error(`Missing configuration: ${k}`);
  }
  if (c.projectLabelPrefix !== undefined && (typeof c.projectLabelPrefix !== 'string' || c.projectLabelPrefix.length > 40)) throw new Error('projectLabelPrefix must be a string of at most 40 characters.');
  const u = new URL(c.serverUrl);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Invalid serverUrl.');
  if (c.clientPresence?.enabled && (!Array.isArray(c.clientPresence.executables) || !c.clientPresence.executables.length || c.clientPresence.executables.some(p => typeof p !== 'string' || !path.isAbsolute(p)))) throw new Error('clientPresence.executables must contain absolute Multica main executable paths.');
  if (c.clientPresence?.resumePolicy && c.clientPresence.resumePolicy !== 'skip') throw new Error('Only clientPresence.resumePolicy=skip is supported.');
  // v0.5 deliberately ignores old autoDiscover=true configurations. Existing
  // explicit bindings continue, but opening a directory no longer grants sync.
  return { pollMs: 500, toolPayloads: false, retryLimit: 10, localWorkspaceRoot: homedir(), ...c, autoDiscover: false };
}
export function configPaths(c) { return { bindings: path.join(c.stateDir, 'bindings'), lock: path.join(c.stateDir, 'daemon.lock'), health: path.join(c.stateDir, 'health.json'), stop: path.join(c.stateDir, 'stop'), log: path.join(c.stateDir, 'daemon.log') }; }
export const defaultCodexHome = path.join(homedir(), '.codex');
