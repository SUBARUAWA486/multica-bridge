import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && arguments.length > 1) return fallback; throw e; }
}
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let n = 0; n < 2; n++) {
    try { const fd = fs.openSync(file, 'wx', 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return () => fs.rmSync(file, { force: true }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid daemon lock; inspect it before removing it.');
      try { process.kill(pid, 0); throw new Error(`Bridge process ${pid} is already running.`); }
      catch (check) { if (check.code !== 'ESRCH') throw check; fs.rmSync(file); }
    }
  }
  throw new Error('Could not acquire daemon lock.');
}
