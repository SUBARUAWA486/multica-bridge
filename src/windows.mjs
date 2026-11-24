import fs from 'node:fs';
import { readSourceBatch } from './source.mjs';

// Operates only on an explicitly selected chat. No prompt bodies are returned.
export function scanTurn(source, endOffset = Infinity) {
  const fd = fs.openSync(source, 'r'), buf = Buffer.alloc(256 * 1024);
  let tail = '', current = null, active = false, position = 0;
  try {
    for (;;) {
      const length = Math.min(buf.length, endOffset - position); if (length <= 0) break;
      const n = fs.readSync(fd, buf, 0, length, position); if (!n) break; position += n;
      const lines = (tail + buf.subarray(0, n).toString('utf8')).split('\n'); tail = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const j = JSON.parse(line), p = j.payload;
        if (j.type !== 'event_msg') continue;
        if (p?.type === 'task_started' && p.turn_id) { current = p.turn_id; active = true; }
        if (['task_complete', 'turn_aborted'].includes(p?.type) && (!p.turn_id || p.turn_id === current)) active = false;
      }
    }
    return { turnId: current, active };
  } finally { fs.closeSync(fd); }
}
export function moveToPresent(b, { preservePending = false, at = new Date().toISOString() } = {}) {
  const stat = fs.statSync(b.source);
  if (stat.ino !== b.inode || stat.size < b.offset) throw new Error('Selected source changed; explicit recovery is required.');
  const turn = scanTurn(b.source, stat.size);
  let partial = false;
  if (stat.size) {
    const fd = fs.openSync(b.source, 'r');
    try { const byte = Buffer.alloc(1); fs.readSync(fd, byte, 0, 1, stat.size - 1); partial = byte[0] !== 10; } finally { fs.closeSync(fd); }
  }
  b.offset = stat.size; b.discardPartialLine = partial; b.captureTurn = turn.active ? turn.turnId : null; b.windowTurn = b.captureTurn;
  if (!preservePending) b.pending = [];
  b.callPolicy = {}; b.windowStartedAt = at;
  return turn;
}
export function readWindowRecords(b, options) {
  const { changed, events } = readSourceBatch(b, options);
  if (!changed) return false;
  const accepted = [];
  for (const e of events) {
    const late = !e.at || Date.parse(e.at) < Date.parse(b.windowStartedAt);
    if (e.kind === 'begin' && !late) b.windowTurn = e.turnId;
    const noTurn = !e.turnId;
    let drop = !b.enabled
      || noTurn || late || e.turnId !== b.windowTurn;
    if (e.kind === 'tool_use') {
      const local = e.localOnly || /(?:mcp__multica_bridge__|multica_bridge[._]|src\/cli\.mjs)/.test(e.tool + JSON.stringify(e.input));
      b.callPolicy ??= {}; b.callPolicy[e.callId] = { turnId: e.turnId, drop: drop || local };
      drop ||= local;
    }
    if (e.kind === 'tool_result') {
      // Unknown tool ownership (e.g. a call begun while paused) is private.
      const call = b.callPolicy?.[e.callId];
      drop ||= !call || call.drop;
    }
    if (!drop) accepted.push(e); else b.filteredEvents = (b.filteredEvents ?? 0) + 1;
    if (e.kind === 'end' && e.turnId === b.windowTurn) b.windowTurn = null;
  }
  b.pending.push(...accepted); b.sourceReadAt = new Date().toISOString();
  return true;
}
