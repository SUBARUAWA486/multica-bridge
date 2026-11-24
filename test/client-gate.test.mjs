import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ClientGate, matchesClient } from '../src/client-gate.mjs';
import { API } from '../src/api.mjs';

test('matches only exact configured main processes, excluding unrelated Electron helpers', () => {
  const exe = '/test/Multica.app/Contents/MacOS/Multica';
  assert.equal(matchesClient('/Applications/Termius.app/Contents/MacOS/Electron\n' + exe + ' Helper\n', [exe]), false);
  assert.equal(matchesClient('  ' + exe + '\n', [exe]), true);
});
test('closed client blocks all HTTP, reopen restores requests, and exit aborts an in-flight request', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-gate-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const profilePath = path.join(dir, 'profile.json'); fs.writeFileSync(profilePath, JSON.stringify({ token: 'test-only-value' }));
  let running = false, requests = 0, sawCloseHeader = false, waitForSlow;
  const slowSeen = new Promise(r => { waitForSlow = r; });
  const server = http.createServer((req, res) => { requests++; sawCloseHeader = req.headers.connection === 'close'; if (req.url === '/slow') { waitForSlow(); return; } res.end('{"ok":true}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const c = { serverUrl: 'http://127.0.0.1:' + server.address().port, profilePath, workspaceId: 'test', clientPresence: { enabled: true, executables: ['/test/Multica'] } };
  const gate = new ClientGate(c, async () => running), api = new API(c, { gate });
  await assert.rejects(api.request('POST', '/api/daemon/heartbeat', {}), e => e.suspended === true && e.requestDelivery === 'not_sent'); assert.equal(requests, 0);
  running = true; await gate.check(true); assert.deepEqual(await api.request('GET', '/test'), { ok: true }); assert.equal(sawCloseHeader, true);
  const pending = api.request('GET', '/slow'); const rejected = assert.rejects(pending, e => e.suspended === true && e.requestDelivery === 'unknown');
  await slowSeen; running = false; await gate.check(true); await rejected;
  const countAtClose = requests;
  await assert.rejects(api.request('POST', '/api/daemon/register', {}), e => e.suspended === true);
  assert.equal(requests, countAtClose);
  running = true; await gate.check(true); assert.deepEqual(await api.request('GET', '/again'), { ok: true });
});
test('unavailable process probe fails closed', async () => {
  const gate = new ClientGate({ clientPresence: { enabled: true } }, async () => { throw new Error('EPERM'); });
  assert.equal(await gate.check(true), false); assert.equal(gate.status().state, 'waiting_for_multica'); assert.match(gate.status().error, /EPERM/);
});

test('API errors include actionable server validation detail without returning the response body', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-error-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const profilePath = path.join(dir, 'profile.json'); fs.writeFileSync(profilePath, JSON.stringify({ token: 'synthetic' }));
  const server = http.createServer((req, res) => { res.statusCode = 400; res.end(JSON.stringify({ code: 'invalid_label', error: 'label not found /Users/example/private sk-abcdefghijklmnop1234', token: 'MUST_NOT_RETURN' })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const api = new API({ serverUrl: 'http://127.0.0.1:' + server.address().port, profilePath, workspaceId: 'test' });
  await assert.rejects(api.request('POST', '/api/issues', {}), e => {
    assert.match(e.message, /HTTP 400: invalid_label: label not found/);
    assert.equal(/MUST_NOT_RETURN|example|abcdefghijklmnop/.test(e.message), false);
    assert.equal(e.status, 400); return true;
  });
});

test('HTTP payload is redacted before reaching the server while authentication remains intact', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-outbound-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const profilePath = path.join(dir, 'profile.json'), token = 'opaque-synthetic-login-credential';
  fs.writeFileSync(profilePath, JSON.stringify({ token })); let received;
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c); req.on('end', () => { received = { auth: req.headers.authorization, body: JSON.parse(raw) }; res.end('{}'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const api = new API({ serverUrl: 'http://127.0.0.1:' + server.address().port, profilePath, workspaceId: 'test' });
  await api.request('POST', '/api/daemon/tasks/task/messages', { messages: [{ seq: 1, input: { password: 'nested-secret' }, output: token + ' password=printed-secret' }], expected_revision: 4 });
  assert.equal(received.auth, 'Bearer ' + token); assert.equal(received.body.expected_revision, 4);
  const wire = JSON.stringify(received.body); for (const value of [token, 'nested-secret', 'printed-secret']) assert.equal(wire.includes(value), false);
});
