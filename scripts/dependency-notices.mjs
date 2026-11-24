// Generate notices from the locked, installed dependency tree. No network access.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
const groups = new Map();
const allowed = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0']);
for (const [dir, entry] of Object.entries(lock.packages)) {
  if (!dir) continue;
  if (!allowed.has(entry.license)) throw new Error(`Review dependency license before release: ${dir}: ${entry.license}`);
  const home = path.join(root, dir), pkg = JSON.parse(fs.readFileSync(path.join(home, 'package.json')));
  if (pkg.version !== entry.version) throw new Error(`Installed dependency differs from lockfile: ${dir}`);
  const files = fs.readdirSync(home).filter(n => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(n) && fs.statSync(path.join(home, n)).isFile()).sort();
  if (!files.some(n => /^(?:licen[cs]e|copying)/i.test(n))) throw new Error(`Missing license text for ${pkg.name}`);
  const text = files.map(n => `File: ${n}\n${fs.readFileSync(path.join(home, n), 'utf8').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()}`).join('\n\n');
  const key = crypto.createHash('sha256').update(text).digest('hex');
  if (!groups.has(key)) groups.set(key, { text, packages: [] });
  groups.get(key).packages.push(`${pkg.name}@${pkg.version} (${entry.license})`);
}
let output = '# Third-party dependency notices\n\nGenerated from package-lock.json and installed license files by `npm run licenses`.\nThis records the current dependency snapshot; the license texts govern.\nGitleaks source-rule attribution is separately preserved in NOTICE and licenses/GITLEAKS.txt.\n';
for (const group of groups.values()) output += `\n## ${group.packages.join(', ')}\n\n\`\`\`text\n${group.text}\n\`\`\`\n`;
const destination = path.join(root, 'THIRD_PARTY_NOTICES.md');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(destination, 'utf8') !== output) throw new Error('Dependency notices are stale; run npm run licenses.');
} else fs.writeFileSync(destination, output);
console.log(`Verified ${Object.keys(lock.packages).length - 1} dependency entries and ${groups.size} notice groups.`);
