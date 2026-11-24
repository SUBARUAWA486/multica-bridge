// Lightweight public-snapshot hygiene checks; never reads private login profiles.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanSecrets, scanHistory } from './scan-secrets.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
if (!files.length) throw new Error('Stage the intended public files before running the release check.');
// npm pack and notice generation read the worktree. Refuse a different staged
// candidate, including staged secrets hidden by a clean-looking unstaged edit.
try { execFileSync('git', ['diff', '--quiet', '--'], { cwd: root }); }
catch { throw new Error('Tracked worktree differs from the Git index. Stage the intended public snapshot before checking.'); }
const failures = [];
const privateFile = /(?:^|\/)(?:config(?:\.[^/]+)?\.local\.json|\.env(?:\..*)?|node_modules|state|runtime|local|outputs|Temp|artifacts|\.git)(?:\/|$)|\.(?:sqlite\w*|db|jsonl|bundle|tgz|tar\.gz|pem|key)$/i;
for (const name of files) {
  if (privateFile.test(name) && name !== '.env.example') { failures.push(`${name}: private/runtime file`); continue; }
  const mode = execFileSync('git', ['ls-files', '--stage', '--', name], { cwd: root, encoding: 'utf8' }).slice(0, 6);
  if (mode !== '100644' && mode !== '100755') { failures.push(`${name}: non-regular index entry requires manual review`); continue; }
  const text = execFileSync('git', ['show', `:${name}`], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  // Test fixtures intentionally contain synthetic paths/addresses. License texts
  // retain their original copyright holders, email addresses and attribution.
  const fixture = name.startsWith('test/');
  const notice = name === 'THIRD_PARTY_NOTICES.md' || name.startsWith('licenses/');
  if (!fixture && !notice && /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//.test(text)) failures.push(`${name}: absolute user-directory path`);
  if (!fixture && !notice && /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/.test(text)) failures.push(`${name}: literal private-network address`);
  if (scanSecrets(name, text).length) failures.push(`${name}: possible credential/private key`);
}
for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/provenance.md', 'docs/compliance.md']) if (!files.includes(name)) failures.push(`${name}: missing required public document`);
const pkg = JSON.parse(execFileSync('git', ['show', ':package.json'], { cwd: root, encoding: 'utf8' }));
if (pkg.license !== 'MIT' || pkg.private !== true) failures.push('package.json: review license / accidental npm-publication guard');
if (failures.length) throw new Error('Public snapshot checks failed:\n' + failures.join('\n'));
execFileSync(process.execPath, ['scripts/dependency-notices.mjs', '--check'], { cwd: root, stdio: 'inherit' });
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-pack-check-'));
let packed;
try {
  const args = ['pack', '--dry-run', '--ignore-scripts', '--offline', '--json', '--cache', cache];
  const command = process.env.npm_execpath ? process.execPath : 'npm';
  const result = execFileSync(command, process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  packed = JSON.parse(result)[0].files.map(f => f.path);
  for (const name of packed) {
    if (privateFile.test(name)) failures.push(`${name}: private file included in package`);
    if (!files.includes(name)) failures.push(`${name}: package file is not in the checked Git index`);
  }
} finally { fs.rmSync(cache, { recursive: true, force: true }); }
if (failures.length) throw new Error('Public snapshot checks failed:\n' + failures.join('\n'));
const history = scanHistory(root);
console.log(JSON.stringify({ history, trackedFiles: files.length, packageFiles: packed.length, license: pkg.license, privateFileChecks: 'passed', legalCertification: false }));
