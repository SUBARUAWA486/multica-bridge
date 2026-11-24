import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, configPaths, projectDir } from './config.mjs';
import { acquireLock, writeJson, readJson } from './storage.mjs';
import { Engine } from './engine.mjs';
import { bindingFile, getBindings, retireBinding } from './bindings.mjs';
import { ClientLifecycle } from './client-lifecycle.mjs';
import { Operations } from './operations.mjs';

const c = loadConfig(), paths = configPaths(c), release = acquireLock(paths.lock);
const engine = new Engine(c);
// Older, already-connected MCP processes also read this health object. Give
// them a stable local bootstrap without needing a client restart or PID hunt.
const control = { version: readJson(path.join(projectDir, 'package.json')).version, workflowCommand: [process.execPath, '--disable-warning=ExperimentalWarning', path.join(projectDir, 'src/cli.mjs'), 'workflow'],
  taskCommands: 'prepare-task <json-file> | sync <json-file> | operation <request-id> | sync-status <thread-id> | task <key> | update-task <key> <json-file>' };
const lifecycle = new ClientLifecycle(c, engine), gate = engine.api.gate;
const operations = new Operations(c, engine);
let stopping = false, lastReconcile = 0;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
try {
  // A process restart re-registers its own runtime before callbacks resume.
  engine.registry.data.registered = false; engine.registry.save();
  for (const b of getBindings(c)) { retireBinding(c, b); if (b.active) b.active.started = false; engine.save(b); }
  console.log(JSON.stringify({ event: 'started', pid: process.pid, at: new Date().toISOString() }));
  gate.start();
  while (!stopping && !fs.existsSync(paths.stop)) {
    // Local pause acknowledgements must work even while Multica is closed.
    await operations.tick();
    if (!await gate.check()) {
      lifecycle.suspend();
      writeJson(paths.health, { running: true, pid: process.pid, at: new Date().toISOString(), control, transport: gate.status() });
      await new Promise(resolve => setTimeout(resolve, c.pollMs)); continue;
    }
    lifecycle.resume();
    const syncRequest = c.stateDir + '/sync-profiles';
    if (fs.existsSync(syncRequest)) {
      engine.registry.data.paused = false; engine.registry.data.errors = 0; delete engine.registry.data.retryAt; engine.registry.save();
      fs.rmSync(syncRequest); lastReconcile = 0;
    }
    if (Date.now() - lastReconcile > 5000) { await engine.registry.reconcile(); lastReconcile = Date.now(); }
    for (const reference of getBindings(c)) {
      await operations.tick();
      // Operations may have changed this binding; never overwrite that state
      // with the earlier loop snapshot.
      const b = readJson(bindingFile(c, reference.id));
      retireBinding(c, b);
      const command = bindingFile(c, b.id) + '.command';
      if (fs.existsSync(command)) {
        fs.rmSync(command); b.legacyCommandRejectedAt = new Date().toISOString(); engine.save(b);
      }
      await engine.tick(b);
    }
    writeJson(paths.health, { running: true, pid: process.pid, at: new Date().toISOString(), control, transport: gate.status() });
    await new Promise(resolve => setTimeout(resolve, c.pollMs));
  }
} finally {
  // Shutdown ends this transport only. Pending data and Codex execution survive.
  try { await engine.registry.stop(); } catch { /* Registration is refreshed after restart. */ }
  gate.stop();
  writeJson(paths.health, { running: false, pid: process.pid, at: new Date().toISOString() }); release();
}
