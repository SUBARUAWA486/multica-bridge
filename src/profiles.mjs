import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, acquireLock } from './storage.mjs';

export const defaultProfile = { name: '通用执行', description: '手动 Codex 会话', instructions: '', model: '', effort: '', skillPaths: [] };
export function profileFile(c, key) {
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(key)) throw new Error('Profile key must be lowercase ASCII, starting with a letter.');
  return path.join(c.stateDir, 'profiles', key + '.json');
}
export function listProfiles(c) {
  const dir = path.join(c.stateDir, 'profiles');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(x => x.endsWith('.json')).map(x => readJson(path.join(dir, x)));
}
export function getProfile(c, key, version) {
  const p = readJson(profileFile(c, key), null);
  if (!p) throw new Error(`Unknown execution profile: ${key}`);
  const selected = version === undefined ? p.versions.at(-1) : p.versions.find(v => v.version === version);
  if (!selected) throw new Error(`Unknown profile version: ${key}@${version}`);
  return { key, latestVersion: p.versions.at(-1).version, ...selected };
}
export function saveProfile(c, key, values, expectedVersion) {
  const file = profileFile(c, key), release = acquireLock(file + '.lock');
  try {
    const current = readJson(file, { key, versions: [] }), last = current.versions.at(-1);
    if (last && expectedVersion !== last.version) throw new Error(`Profile version changed; read ${key}@${last.version} before updating.`);
    const next = { ...defaultProfile, ...(last?.settings ?? {}), ...values };
    if (!next.name || next.name.length > 100 || next.description.length > 180) throw new Error('Invalid profile name or description length.');
    if (!Array.isArray(next.skillPaths) || next.skillPaths.some(x => typeof x !== 'string' || !path.isAbsolute(x))) throw new Error('skillPaths must contain absolute paths.');
    if (last && JSON.stringify(last.settings) === JSON.stringify(next)) return getProfile(c, key);
    const v = { version: (last?.version ?? 0) + 1, savedAt: new Date().toISOString(), settings: next };
    current.versions.push(v); writeJson(file, current); return getProfile(c, key);
  } finally { release(); }
}
export function ensureProfiles(c) {
  if (!fs.existsSync(profileFile(c, 'general'))) saveProfile(c, 'general', defaultProfile);
}
export function getDefaultProfile(c) {
  const key = readJson(path.join(c.stateDir, 'settings.json'), {}).defaultProfile ?? c.defaultProfile ?? 'general';
  return getProfile(c, key);
}
export function setDefaultProfile(c, key) {
  getProfile(c, key);
  writeJson(path.join(c.stateDir, 'settings.json'), { defaultProfile: key }); return { defaultProfile: key };
}
export function assignProfile(c, b, key, version) {
  const selected = getProfile(c, key, version);
  if (b.profileKey !== key && b.remote.sessionId) {
    throw new Error('An established chat keeps its mirror identity.');
  }
  b.profileKey = key; b.profileVersion = selected.version;
}
export function configurationStatus(c, b) {
  if (!b.profileKey) return null;
  const p = getProfile(c, b.profileKey, b.profileVersion), observed = b.observed ?? {};
  const match = (wanted, actual) => !wanted ? 'inherit' : !actual ? 'unknown' : wanted === actual ? 'match' : 'mismatch';
  return { profileKey: p.key, boundVersion: p.version, savedVersion: p.latestVersion,
    updateAvailable: p.version !== p.latestVersion,
    model: { desired: p.settings.model, observed: observed.model ?? null, status: match(p.settings.model, observed.model) },
    effort: { desired: p.settings.effort, observed: observed.effort ?? null, status: match(p.settings.effort, observed.effort) } };
}
