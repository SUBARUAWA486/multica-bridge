import test from 'node:test';
import assert from 'node:assert/strict';
import { publicText, publicValue, outboundBody } from '../src/privacy.mjs';

test('common secrets are removed from text, including partial private keys', () => {
  const secrets = ['ghp_' + 'a'.repeat(36), 'glpat-' + 'b'.repeat(20), 'github_pat_' + 'c'.repeat(24), 'AKIA' + 'A'.repeat(16), 'sk-' + 'd'.repeat(24), 'ey' + 'e'.repeat(12) + '.' + 'f'.repeat(12) + '.' + 'g'.repeat(12)];
  const input = [...secrets, 'PASSWORD="two words"', 'api_key: arbitrary-value', 'postgresql://user:dbpass@host/db', 'Bearer opaque-token-123456', ['-----BEGIN OPENSSH', 'PRIVATE KEY-----\nprivate key material'].join(' ')].join('\n');
  const output = publicText(input);
  for (const secret of [...secrets, 'two words', 'arbitrary-value', 'dbpass', 'opaque-token-123456', 'private key material']) assert.equal(output.includes(secret), false);
  assert.equal(publicText(output), output);
});
test('nested tool payloads and serialized JSON redact sensitive values without corrupting JSON', () => {
  const value = { safe: 'task summary', child: [{ password: 'multi word secret', clientSecret: 'other', session: { token: 'custom-value' } }], cookie: 'session=abc', enabled: false };
  const filtered = publicValue(value);
  assert.equal(filtered.child[0].password, '[REDACTED]'); assert.equal(filtered.child[0].clientSecret, '[REDACTED]');
  assert.equal(filtered.child[0].session.token, '[REDACTED]'); assert.equal(filtered.enabled, false);
  assert.deepEqual(JSON.parse(publicText(JSON.stringify(value))), filtered);
  assert.equal(filtered.safe, value.safe);
  const encoded = JSON.stringify({ output: JSON.stringify({ password: 'inner-secret', safe: 'keep' }) });
  const result = JSON.parse(publicText(encoded)); assert.equal(JSON.parse(result.output).password, '[REDACTED]');
});
test('privacy flags are opt-in and do not redact authorization decisions or normal URLs by default', () => {
  const text = 'http://172.16.0.2:3000/ws/task user@example.com https://github.com/org/repo/pull/12';
  assert.equal(publicText(text), text);
  const privateText = publicText(text, { privacy: { redactInternalAddresses: true, redactEmails: true } });
  assert.equal(privateText.includes('172.16.0.2'), false); assert.equal(privateText.includes('user@example.com'), false);
  assert.ok(privateText.includes('https://github.com/org/repo/pull/12'));
  assert.equal(publicText('user_authorization: medium'), 'user_authorization: medium');
});
test('outbound guard filters business fields but preserves routing and concurrency guards', () => {
  const base = 'password=original-value';
  const body = { id: 'issue', expected_revision: 3, description_base: base, title_base: base, description: 'password=new-value',
    messages: [{ seq: 2, idempotency_key: 'stable-id', input: { apiToken: 'custom' }, output: 'known-login-token-value' }] };
  const filtered = outboundBody(body, { knownSecrets: ['known-login-token-value'] });
  assert.equal(filtered.description_base, base); assert.equal(filtered.title_base, base);
  assert.equal(filtered.expected_revision, 3); assert.equal(filtered.messages[0].idempotency_key, 'stable-id');
  assert.equal(filtered.messages[0].input.apiToken, '[REDACTED]'); assert.equal(filtered.messages[0].output, '[REDACTED]');
  assert.equal(filtered.description.includes('new-value'), false); assert.equal(body.messages[0].output, 'known-login-token-value');
});

test('JSON redaction preserves large identifiers and original numeric literals', () => {
  const input = '{"recordId":9223372036854775807,"values":[-9223372036854775809,1.2300,1e+400,-0],"password":"synthetic-secret","safe":"unchanged"}';
  const expected = input.replace('synthetic-secret', '[REDACTED]');
  assert.equal(publicText(input), expected);
  assert.equal(publicText(expected), expected);
  const nested = JSON.stringify({ output: input });
  assert.equal(JSON.parse(publicText(nested)).output, expected);
  assert.equal(publicText('{ "n": 9223372036854775807 }'), '{ "n": 9223372036854775807 }');
});
