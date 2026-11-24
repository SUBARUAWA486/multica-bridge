import path from 'node:path';
import { homedir } from 'node:os';
import { redactTokenFormats } from './secret-patterns.mjs';

const sensitiveKey = /^(?:password|passwd|pwd|secret|clientsecret|apisecret|apikey|token|apitoken|authorization|accesstoken|refreshtoken|authtoken|privatekey|awssecretaccesskey|secretaccesskey|cookie|setcookie)$/i;
const credentialName = '(?:password|passwd|api[_-]?key|api[_-]?secret|client[_-]?secret|secret[_-]?key|secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|private[_-]?key|aws_secret_access_key|database_url|db_password|db_url|redis_url)';
const assignment = new RegExp('(^|[^\\w])(["\']?' + credentialName + '["\']?\\s*[=:]\\s*)(?:"[^"\\r\\n]*"|\'[^\'\\r\\n]*\'|[^\\s,;}]+)', 'gim');

function secretsText(value, c) {
  let text = String(value);
  for (const secret of c.knownSecrets ?? []) if (typeof secret === 'string' && secret.length >= 8) text = text.split(secret).join('[REDACTED]');
  return redactTokenFormats(text)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(/\b((?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(^|[^\w])(["']?(?:cookie|set-cookie)["']?\s*:\s*)[^\r\n]+/gim, '$1$2[REDACTED]')
    .replace(assignment, '$1$2[REDACTED]');
}

// Best-effort outbound presentation filtering, never filesystem access control.
export function publicText(value, c = {}, resources = []) {
  let text = String(value);
  // Preserve ordinary output formatting; only reserialize JSON when a value changed.
  if (/^\s*[\[{]/.test(text)) {
    try {
      const parsed = JSON.parse(text), filtered = publicValue(parsed, c, resources);
      return JSON.stringify(parsed) !== JSON.stringify(filtered) ? JSON.stringify(filtered) : text;
    } catch { /* Mixed tool output uses the text rules below. */ }
  }
  text = secretsText(text, c);
  if (c.privacy?.redactInternalAddresses) text = text.replace(/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g, '[内部地址]');
  if (c.privacy?.redactEmails) text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[邮箱]');
  const entries = resources.map(r => [r.path, `[${r.alias}]`]);
  for (const [p, alias] of [[c.codexHome, '[Codex本地]'],
    [c.localWorkspaceRoot, '[本地工作区]'], [homedir(), '[用户目录]']]) if (p) entries.push([p, alias]);
  for (const [p, alias] of entries.sort((a, b) => b[0].length - a[0].length)) {
    // Prefix boundaries prevent e.g. /repo from matching /repository.
    text = text.split(p).map((part, i) => i && part && !/^[\\/\s"'`<>),;:\]}]|^$/.test(part) ? p + part : (i ? alias : '') + part).join('');
  }
  // Hide any remaining home-directory path, including another user's name.
  return text.replace(/\/(?:Users|home)\/[^\s/"'`<>]+(?:\/[^\s"'`<>\n),;\]}]*)?/g, '[本地路径]')
    .replace(/\/(?:private\/)?(?:tmp|var\/folders)\/[^\s"'`<>\n),;\]}]*/g, '[本地临时路径]')
    .replace(/\b[A-Za-z]:\\(?:[^\s"'`<>\n]+\\?)+/g, '[本地路径]');
}
export function publicValue(value, c = {}, resources = [], depth = 0) {
  if (depth > 32) return '[REDACTED_DEPTH_LIMIT]';
  if (typeof value === 'string') return publicText(value, c, resources);
  if (Array.isArray(value)) return value.map(v => publicValue(v, c, resources, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [publicText(k, c, resources), sensitiveKey.test(k.replace(/[_-]/g, '')) ? '[REDACTED]' : publicValue(v, c, resources, depth + 1)]));
  return value;
}
export function validateResources(resources = []) {
  const aliases = new Set();
  for (const r of resources) {
    if (!/^[\p{L}\p{N}_ -]{1,60}$/u.test(r.alias) || aliases.has(r.alias) || !path.isAbsolute(r.path)) throw new Error('Resources require unique readable aliases and absolute local paths.');
    aliases.add(r.alias);
  }
  return resources;
}

// Filter business content only: routing IDs, revision guards and description bases
// must stay byte-for-byte unchanged. Authentication stays in the HTTP header.
const contentFields = new Set(['title', 'description', 'instructions', 'content', 'input', 'output', 'error', 'name', 'device_name']);
export function outboundBody(body, c) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key,
    key === 'messages' && Array.isArray(value) ? value.map(row => outboundBody(row, c))
      : contentFields.has(key) ? publicValue(value, c, c.resources) : value]));
}
