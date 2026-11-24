// Best-effort format scanning of the public repository, never credential stores.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { secretFormatMatches } from '../src/secret-patterns.mjs';

// Exact file + full matched value digest only. No directory, prefix or rule bypass.
// Synthetic API-error fixture; keep this list small and review changes manually.
const fixtures = new Map([
  ['test/client-gate.test.mjs', new Set([
    '6c2b82b5db2d55c4e1869eecd8b5d53af11425839bde5ee86a55d300c93e819e',
  ])],
  // Historical synthetic incomplete PEM fixture; exact old matched tails only.
  ['test/privacy.test.mjs', new Set([
    'b40e543a9d20373c9d16375da737947ac31b50275a5a13ca4122b676d07838d8',
    '0bc63dd96da91516640fdda3ceedc8ddabe9a02671af28cbc93b1453e0257b72',
  ])],
]);
export function scanSecrets(name, text) {
  // AWS secret keys have no identifying prefix; require the explicit field name.
  const awsSecret = /["']?aws[_-]?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi;
  const contextual = [...text.matchAll(awsSecret)].map(match => ({ value: match[1], index: match.index }));
  return [...secretFormatMatches(text), ...contextual].filter(({ value }) =>
    !fixtures.get(name)?.has(createHash('sha256').update(value).digest('hex')));
}
const git = (root, args) => execFileSync('git', args, {
  cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});
export function scanHistory(root) {
  // All reachable branches/tags, not just HEAD. Unique blob/path pairs keep this
  // inexpensive while preserving file-specific fixture exemptions across renames.
  if (git(root, ['rev-parse', '--is-shallow-repository']).trim() === 'true')
    throw new Error('Full history required: fetch with --unshallow before the release check.');
  const commits = git(root, ['rev-list', '--all']).trim().split('\n').filter(Boolean);
  const seen = new Set(), failures = [];
  for (const commit of commits) {
    if (scanSecrets('', git(root, ['show', '-s', '--format=%B', commit])).length)
      failures.push(`${commit}: possible credential in commit message`);
    for (const entry of git(root, ['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t'), name = entry.slice(tab + 1);
      const [, type, oid] = entry.slice(0, tab).split(' ');
      if (type !== 'blob' || seen.has(`${oid}:${name}`)) continue;
      seen.add(`${oid}:${name}`);
      if (scanSecrets(name, git(root, ['cat-file', 'blob', oid])).length)
        failures.push(`${commit}:${name}: possible credential in history`);
    }
  }
  if (failures.length) throw new Error('Secret history checks failed (values withheld):\n' + failures.join('\n'));
  return { commits: commits.length, blobPaths: seen.size, result: 'passed' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(scanHistory(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))));
}
