import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanSecrets, scanHistory } from '../scripts/scan-secrets.mjs';

test('release rules detect Multica and other supported formats even in tests and notices', () => {
  const values = ['mul_', 'mat_', 'mdt_', 'ghp_', 'glpat-', 'sk-', 'xoxb-', 'sk_live_'].map(p => p + 'a'.repeat(36));
  values.push('AKIA' + 'A'.repeat(16), 'ASIA' + 'B'.repeat(16), 'AIza' + 'a'.repeat(35),
    'ey' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12),
    ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' '));
  values.push('aws_secret_access_key = \"' + 'A'.repeat(40) + '\"');
  for (const name of ['README.md', 'test/new.test.mjs', 'licenses/example.txt'])
    for (const value of values) assert.ok(scanSecrets(name, value).length, name);
});

test('synthetic exemption requires both the exact path and full matched value', () => {
  const fake = 'sk-' + 'abcdefghijklmnop1234';
  assert.equal(scanSecrets('test/client-gate.test.mjs', fake).length, 0);
  assert.equal(scanSecrets('test/other.test.mjs', fake).length, 1);
  assert.equal(scanSecrets('test/client-gate.test.mjs', fake + 'X').length, 1);
});

test('history scan detects deleted secrets on a non-current branch and in commit messages', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-history-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'example.txt'), 'clean'); git('add', '.'); git('commit', '--quiet', '-m', 'clean');
  assert.equal(scanHistory(dir).commits, 1);
  git('checkout', '--quiet', '-b', 'old');
  const secret = 'mul_' + 'q'.repeat(36);
  fs.writeFileSync(path.join(dir, 'example.txt'), secret); git('add', '.'); git('commit', '--quiet', '-m', 'fixture');
  fs.writeFileSync(path.join(dir, 'example.txt'), 'clean'); git('add', '.'); git('commit', '--quiet', '-m', 'removed');
  git('checkout', '--quiet', 'main');
  assert.throws(() => scanHistory(dir), error => /example.txt: possible credential in history/.test(error.message) && !error.message.includes(secret));
  git('branch', '-D', 'old');
  git('commit', '--quiet', '--allow-empty', '-m', secret);
  assert.throws(() => scanHistory(dir), error => /commit message/.test(error.message) && !error.message.includes(secret));
});
