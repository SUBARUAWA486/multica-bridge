import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { publicText, publicValue } from './privacy.mjs';

function isInternalThread(row) {
  return ['guardian_review', 'subagent', 'review', 'auto_review'].includes(row.thread_source)
    || /"subagent"\s*:/.test(row.source ?? '') || ['guardian', 'reviewer'].includes(row.agent_role);
}
function metadataColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(r => r.name));
  return ['source', 'thread_source', 'agent_role'].filter(k => columns.has(k));
}

export function threadMetadata(c, threadId) {
  const db = new DatabaseSync(path.join(c.codexHome, 'state_5.sqlite'), { readOnly: true });
  try {
    const fields = metadataColumns(db);
    const row = db.prepare(`SELECT id,cwd,rollout_path${fields.map(k => ',' + k).join('')} FROM threads WHERE id=?`).get(threadId);
    if (!row) throw new Error('Thread not found in the local Codex index.');
    if (isInternalThread(row)) throw new Error('Internal Codex review/subagent threads cannot be mirrored.');
    const root = fs.realpathSync(path.join(c.codexHome, 'sessions')) + path.sep;
    const source = fs.realpathSync(row.rollout_path);
    if (!source.startsWith(root)) throw new Error('Thread rollout is outside the configured sessions directory.');
    return { threadId: row.id, cwd: row.cwd, source };
  } finally { db.close(); }
}
export function eventKey(j) { return createHash('sha256').update(JSON.stringify(j)).digest('hex'); }
function visibleText(p) { return (p.content ?? []).filter(c => ['text', 'input_text', 'output_text'].includes(c.type)).map(c => c.text ?? '').join('\n'); }
export function visibleUserText(text) {
  // Match the actual client envelope, not arbitrary mentions of AGENTS.md.
  // A record may contain injected instructions/environment AND a real prompt.
  let previous;
  do {
    previous = text;
    text = text.replace(/^\s*# AGENTS\.md instructions for [^\r\n]+\r?\n\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/, '');
    text = text.replace(/(^|\n)[ \t]*<(environment_context|system-reminder|permissions instructions|multica_local_context)>[\s\S]*?<\/\2>[ \t]*(?=\n|$)/g, '$1');
  } while (previous !== text);
  return text.trim();
}
export function convertRecord(j, options = {}) {
  const p = j.payload;
  if (!p) return null;
  const base = { key: eventKey(j), at: j.timestamp };
  if (j.type === 'turn_context' && typeof p.model === 'string') return { ...base, kind: 'configuration', model: p.model, effort: p.effort ?? p.reasoning_effort };
  if (j.type === 'event_msg') {
    if (p.type === 'task_started') return { ...base, kind: 'begin', turnId: p.turn_id };
    if (['task_complete', 'turn_aborted'].includes(p.type)) return { ...base, kind: 'end', turnId: p.turn_id, interrupted: p.type === 'turn_aborted', error: p.error?.message ? publicText(p.error.message, options, options.resources) : undefined };
    return null;
  }
  if (j.type !== 'response_item') return null;
  if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
    if (p.channel && !['commentary', 'final'].includes(p.channel)) return null;
    if (p.role === 'assistant' && !['commentary', 'final_answer', undefined].includes(p.phase)) return null;
    const text = p.role === 'user' ? visibleUserText(visibleText(p)) : visibleText(p);
    // Client-injected environment context is not a user-authored message.
    if (!text || (p.role === 'user' && /^\s*<(?:environment_context|system-reminder|permissions instructions)>/.test(text))) return null;
    return { ...base, kind: p.role, text: publicText(text, options, options.resources), final: p.phase === 'final_answer' };
  }
  if (['custom_tool_call', 'function_call'].includes(p.type)) {
    let input = p.arguments ?? p.input ?? '';
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { text: input }; } }
    return { ...base, kind: 'tool_use', callId: p.call_id, tool: p.name || 'tool', localOnly: /(?:mcp__multica_bridge__|multica_bridge[._]|src\/cli\.mjs)/.test((p.name ?? '') + JSON.stringify(input)), input: options.toolPayloads ? publicValue(input, options, options.resources) : { note: '工具参数未启用同步' } };
  }
  if (['custom_tool_call_output', 'function_call_output'].includes(p.type)) {
    const output = p.output ?? '';
    const raw = typeof output === 'string' ? output : JSON.stringify(output);
    // Native app-created chats receive the initial prompt and steers as a tool
    // result, rather than a role=user message. Only unwrap the exact envelope.
    if (['create_thread', 'send_message_to_thread'].includes(p.name) && /^\s*<codex_delegation>/.test(raw)) {
      const input = raw.match(/<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/)?.[1];
      if (input) {
        const text = visibleUserText(input);
        return text ? { ...base, kind: 'user', text: publicText(text, options, options.resources) } : null;
      }
    }
    return { ...base, kind: 'tool_result', callId: p.call_id, output: options.toolPayloads ? publicText(raw, options, options.resources).slice(0, 60000) : '工具执行完成；输出原文未启用同步', truncated: !options.toolPayloads || raw.length > 60000 };
  }
  return null;
}
export function readSourceBatch(binding, options) {
  const stat = fs.statSync(binding.source);
  if (stat.ino !== binding.inode || stat.size < binding.offset) throw new Error('Source changed or truncated; explicit rebind required.');
  const length = Math.min(stat.size - binding.offset, 2 * 1024 * 1024);
  if (!length) return { changed: false, events: [] };
  const fd = fs.openSync(binding.source, 'r');
  let buf;
  try { buf = Buffer.alloc(length); fs.readSync(fd, buf, 0, length, binding.offset); } finally { fs.closeSync(fd); }
  const last = buf.lastIndexOf(10);
  if (last < 0) {
    if (binding.discardPartialLine) { binding.offset += length; return { changed: true, events: [] }; }
    if (length === 2 * 1024 * 1024) throw new Error('Rollout record exceeds 2 MiB; explicit handling required.'); return { changed: false, events: [] };
  }
  // Return only this fresh batch; never read or mutate the accepted outbox.
  // The caller persists its accepted events together with this cursor.
  const start = binding.discardPartialLine ? buf.indexOf(10) + 1 : 0;
  const events = [];
  let captureTurn = binding.captureTurn;
  for (const line of buf.subarray(start, Math.max(start, last)).toString('utf8').split('\n').filter(Boolean)) {
    const j = JSON.parse(line), p = j.payload ?? {};
    if (j.type === 'event_msg' && p.type === 'task_started') captureTurn = p.turn_id;
    const e = convertRecord(j, options);
    if (!e) continue;
    e.turnId ??= p.turn_id ?? p.internal_chat_message_metadata_passthrough?.turn_id ?? captureTurn;
    if (!binding.skipBefore || Date.parse(e.at) >= Date.parse(binding.skipBefore)) events.push(e);
  }
  binding.discardPartialLine = false;
  binding.captureTurn = captureTurn; binding.offset += last + 1;
  return { changed: true, events };
}
