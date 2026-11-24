import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-release-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.copyFileSync(path.join(root, 'src/secret-patterns.mjs'), path.join(dir, 'src/secret-patterns.mjs'));
  fs.copyFileSync(path.join(root, 'scripts/scan-secrets.mjs'), path.join(dir, 'scripts/scan-secrets.mjs'));
  fs.copyFileSync(path.join(root, 'scripts/check-release.mjs'), path.join(dir, 'scripts/check-release.mjs'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, license: 'MIT' }));
  fs.writeFileSync(path.join(dir, 'README.md'), 'Public example\n');
  execFileSync('git', ['init', '--quiet', dir]);
  const git = (...args) => execFileSync('git', args, { cwd: dir });
  git('add', '.');
  return { dir, git, check: () => spawnSync(process.execPath, ['scripts/check-release.mjs'], { cwd: dir, encoding: 'utf8' }) };
}

test('release check rejects a staged secret hidden by an unstaged clean copy', t => {
  const { dir, git, check } = fixture(t);
  fs.writeFileSync(path.join(dir, 'README.md'), 'ghp_' + 'a'.repeat(36));
  git('add', 'README.md');
  fs.writeFileSync(path.join(dir, 'README.md'), 'Public example\n');
  const result = check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /worktree differs from the Git index/);
});

test('release check detects credentials in the actual staged snapshot', t => {
  const { dir, git, check } = fixture(t);
  fs.writeFileSync(path.join(dir, 'README.md'), 'ghp_' + 'a'.repeat(36));
  git('add', 'README.md');
  const result = check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /README.md: possible credential/);
  assert.equal(result.stderr.includes('ghp_' + 'a'.repeat(36)), false);
});

test('release check rejects an untracked source file selected by npm pack', t => {
  const { dir, git, check } = fixture(t);
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const name of tracked) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.copyFileSync(path.join(root, name), path.join(dir, name));
  }
  git('add', '.');
  // Installed dependencies are prerequisites, not part of the candidate snapshot.
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(dir, 'src/unreviewed.mjs'), 'export const example = true;\n');
  const result = check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /src\/unreviewed.mjs: package file is not in the checked Git index/);
});
