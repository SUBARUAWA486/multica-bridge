import fs from 'node:fs';
import { loadConfig, configPaths } from './config.mjs';
import { start, status, manageProfile, taskStatus, syncControl, syncStatus } from './control.mjs';
import { getProfile } from './profiles.mjs';
import { prepareTask, updateTask, taskContext } from './tasks.mjs';
import { workflow } from './workflow.mjs';
import { operation } from './operations.mjs';
const [command = 'status', id, ...args] = process.argv.slice(2);
const c = command === 'workflow' ? undefined : loadConfig();
try {
  let result;
  if (command === 'status') result = status(c);
  else if (command === 'workflow') result = workflow;
  else if (command === 'sync') result = await syncControl(c, JSON.parse(fs.readFileSync(id, 'utf8')));
  else if (command === 'operation') result = operation(c, id);
  else if (command === 'sync-status') result = await syncStatus(c, id);
  else if (command === 'prepare-task') result = await prepareTask(c, JSON.parse(fs.readFileSync(id, 'utf8')));
  else if (command === 'task') result = await taskStatus(c, id);
  else if (command === 'task-context') result = taskContext(c, id);
  else if (command === 'update-task') { const { status_source, ...fields } = JSON.parse(fs.readFileSync(args[0], 'utf8')); result = await updateTask(c, id, fields, undefined, { statusSource: status_source }); }
  else if (command === 'start') result = start(c);
  else if (command === 'profile') result = getProfile(c, id, args[0] ? Number(args[0]) : undefined);
  else if (command === 'save-profile') result = manageProfile(c, id, JSON.parse(fs.readFileSync(args[0], 'utf8')), args[1] ? Number(args[1]) : undefined);
  else if (command === 'shutdown') { fs.writeFileSync(configPaths(c).stop, 'stop\n', { mode: 0o600 }); result = { requested: 'shutdown' }; }
  else throw new Error('Commands: status | workflow | start | shutdown | prepare-task | task | task-context | update-task | sync | operation | sync-status | profile | save-profile');
  console.log(JSON.stringify(result, null, 2));
} catch (e) { console.error(e.message); process.exitCode = 1; }
