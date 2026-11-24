import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './storage.mjs';
import { getBindings } from './bindings.mjs';
import { moveToPresent } from './windows.mjs';

export function skipToPresent(b) {
  const stat = fs.statSync(b.source);
  if (stat.ino !== b.inode || stat.size < b.offset) throw new Error('Source changed while Multica was closed; explicit rebind required.');
  let partial = false;
  if (stat.size) {
    const fd = fs.openSync(b.source, 'r');
    try { const byte = Buffer.alloc(1); fs.readSync(fd, byte, 0, 1, stat.size - 1); partial = byte[0] !== 10; }
    finally { fs.closeSync(fd); }
  }
  b.offset = stat.size; b.discardPartialLine = partial; b.clientSuspended = true;
}
export class ClientLifecycle {
  constructor(c, engine) { this.c = c; this.engine = engine; this.file = path.join(c.stateDir, 'client-lifecycle.json'); this.state = readJson(this.file, { closed: false }); }
  checkpoint(b, resumedAt) {
    try {
      if (resumedAt) { moveToPresent(b, { preservePending: true, at: resumedAt }); b.clientSuspended = true; b.skipBefore = resumedAt; }
      else skipToPresent(b);
    }
    catch (e) { b.paused = true; b.lastError = e.message; }
    this.engine.save(b);
  }
  suspend() {
    if (!this.state.closed) { this.state = { closed: true, closedAt: new Date().toISOString() }; writeJson(this.file, this.state); }
    const d = this.engine.registry.data;
    if (d.registered) { d.registered = false; delete d.heartbeatAt; this.engine.registry.save(); }
    for (const b of getBindings(this.c)) if (b.enabled) this.checkpoint(b);
  }
  resume() {
    if (!this.state.closed) return;
    const resumedAt = new Date().toISOString();
    for (const b of getBindings(this.c)) if (b.enabled) this.checkpoint(b, resumedAt);
    this.state = { closed: false, resumedAt }; writeJson(this.file, this.state);
  }
}
