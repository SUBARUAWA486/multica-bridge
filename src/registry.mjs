import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './storage.mjs';
import { getProfile, listProfiles } from './profiles.mjs';
import { list } from './api.mjs';
import { publicText } from './privacy.mjs';
import { projectDir } from './config.mjs';

const version = readJson(path.join(projectDir, 'package.json')).version;

// Only the bridge daemon writes remote-registry.json. Management tools write desired profiles.
export class Registry {
  constructor(c, api) {
    this.c = c; this.api = api; this.file = path.join(c.stateDir, 'remote-registry.json');
    this.data = readJson(this.file, { installationId: randomUUID(), agents: {}, registered: false }); this.save();
  }
  save() { writeJson(this.file, this.data); }
  async ensureRuntime() {
    const d = this.data;
    if (!d.registered) {
      const result = await this.api.request('POST', '/api/daemon/register', {
        workspace_id: this.c.workspaceId, daemon_id: `codex-mirror-${d.installationId}`, device_name: 'Codex bridge', cli_version: `multica-bridge/${version}`,
        runtimes: [{ name: 'Codex Mirror (no model)', type: 'codex', version: `event-bridge/${version}`, status: 'online' }] });
      d.runtimeId = result.runtimes[0].id; d.registered = true; this.save();
    }
    if (!d.heartbeatAt || Date.now() - d.heartbeatAt > 12000) {
      await this.api.request('POST', '/api/daemon/heartbeat', { runtime_id: d.runtimeId }); d.heartbeatAt = Date.now(); this.save();
    }
    return d.runtimeId;
  }
  async ensureAgent(key) {
    const runtimeId = await this.ensureRuntime(), profile = getProfile(this.c, key), d = this.data;
    const marker = `[multica-bridge:${d.installationId}:${key}]`;
    const body = { name: publicText(`Codex 镜像 · ${profile.settings.name}`, this.c), description: publicText(`${profile.settings.description} · 配置 v${profile.version}`, this.c).slice(0, 255),
      instructions: publicText(`${marker}\n镜像身份：由手动 Codex 执行，桥接不启动模型；此处配置不会自动改变 Codex。\n配置版本：${profile.version}\n\n${profile.settings.instructions}`, this.c),
      runtime_id: runtimeId, max_concurrent_tasks: 50 };
    let remote = d.agents[key];
    if (!remote) {
      const agents = list(await this.api.request('GET', '/api/agents'), 'agents');
      let agent = agents.find(a => a.instructions?.startsWith(marker) && a.runtime_id === runtimeId);
      if (!agent) agent = await this.api.request('POST', '/api/agents', { ...body, permission_mode: 'private' });
      remote = d.agents[key] = { id: agent.id, projectedVersion: 0 }; this.save();
    }
    if (remote.projectedVersion !== profile.version) {
      await this.api.request('PUT', `/api/agents/${remote.id}`, body);
      remote.projectedVersion = profile.version; this.save();
    }
    return remote.id;
  }
  async stop() {
    if (!this.data.registered) return;
    await this.api.request('POST', '/api/daemon/deregister', { runtime_ids: [this.data.runtimeId] });
    this.data.registered = false; this.save();
  }
  async reconcile() {
    const d = this.data;
    if (d.paused || (d.retryAt && Date.now() < d.retryAt)) return;
    try {
      for (const p of listProfiles(this.c)) await this.ensureAgent(p.key);
      d.errors = 0; delete d.lastError; delete d.retryAt; this.save();
    } catch (e) {
      if (e.suspended) { d.registered = false; this.save(); return; }
      d.errors = (d.errors ?? 0) + 1; d.lastError = e.message;
      d.paused = e.retryable === false || d.errors >= this.c.retryLimit;
      d.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(d.errors, 5)); this.save();
    }
  }
}
