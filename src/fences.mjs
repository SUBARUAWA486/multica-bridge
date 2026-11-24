import path from 'node:path';
import { readJson } from './storage.mjs';

const uuid = v => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
export function fenceFile(c, id) { if (!uuid(id)) throw new Error('Invalid thread ID.'); return path.join(c.stateDir, 'fences', id + '.json'); }
export function blocked(c, id) { return readJson(fenceFile(c, id), null)?.blocked === true; }
export class ControlPending extends Error { constructor() { super('Synchronization control is pending.'); this.suspended = true; } }
export function checkFence(c, id) { if (blocked(c, id)) throw new ControlPending(); }
