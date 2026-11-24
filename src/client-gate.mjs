import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export class ClientClosedError extends Error {
  constructor() { super('Multica is not running; server communication is suspended.'); this.suspended = true; this.code = 'MULTICA_CLOSED'; }
}
export function matchesClient(output, executables) {
  const expected = new Set(executables.map(p => { try { return fs.realpathSync(p); } catch { return p; } }));
  return output.split('\n').some(line => expected.has(line.trim()));
}
export class ClientGate {
  constructor(config, probe) {
    this.options = config.clientPresence ?? { enabled: false };
    this.open = !this.options.enabled; this.controller = new AbortController(); this.checkedAt = 0;
    if (!this.open) this.controller.abort();
    this.probe = probe ?? (async () => {
      const { stdout } = await execute('/bin/ps', ['-ww', '-axo', 'comm='], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
      return matchesClient(stdout, this.options.executables);
    });
  }
  async check(force = false) {
    if (!this.options.enabled) return true;
    if (!force && Date.now() - this.checkedAt < 250) return this.open;
    if (this.checking) return this.checking;
    this.checking = (async () => {
      let running = false;
      try { running = await this.probe(); delete this.error; }
      catch (e) { this.error = `Client process check failed: ${e.message}`; }
      this.checkedAt = Date.now();
      if (running && !this.open) this.controller = new AbortController();
      if (!running) this.controller.abort();
      this.open = running; return running;
    })();
    try { return await this.checking; } finally { this.checking = null; }
  }
  start() { if (this.options.enabled && !this.timer) this.timer = setInterval(() => this.check(true), 1000); }
  stop() { clearInterval(this.timer); this.timer = null; }
  async signal() { if (!await this.check()) throw new ClientClosedError(); return this.controller.signal; }
  status() { return { enabled: Boolean(this.options.enabled), clientRunning: this.open, state: this.open ? 'connected' : 'waiting_for_multica', ...(this.error ? { error: this.error } : {}) }; }
}
