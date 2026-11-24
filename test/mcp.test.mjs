import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { workflow, mcpInstructions } from '../src/workflow.mjs';
import { fileURLToPath } from 'node:url';

test('official MCP client discovers scoped control tools without exposing credentials', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../src/mcp.mjs', import.meta.url))], stderr: 'pipe' });
  const client = new Client({ name: 'bridge-test', version: '1' });
  try {
    await client.connect(transport);
    assert.equal(client.getInstructions(), mcpInstructions);
    const rules = await client.callTool({ name: 'get_workflow', arguments: {} });
    assert.deepEqual(JSON.parse(rules.content[0].text), workflow);
    const result = await client.listTools();
    assert.deepEqual(result.tools.map(t => t.name).sort(), ['connect_current', 'get_operation', 'get_profile', 'get_status', 'get_sync_status', 'get_task', 'get_task_context', 'get_task_options', 'get_workflow', 'pause_sync', 'prepare_task', 'resume_sync', 'save_profile', 'start_bridge', 'update_task']);
    assert.ok(result.tools.find(t => t.name === 'connect_current').inputSchema.required.includes('thread_id'));
    const prepare = result.tools.find(t => t.name === 'prepare_task').inputSchema;
    assert.equal(prepare.properties.brief, undefined); assert.equal(prepare.properties.first_message, undefined);
    assert.ok(prepare.properties.parent_key);
    assert.ok(prepare.properties.issue.properties.status);
    assert.ok(prepare.properties.issue.properties.assignee_id);
    assert.equal(prepare.properties.issue.additionalProperties, false);
    assert.equal(JSON.stringify(result).includes('Bearer'), false);
  } finally { await client.close(); }
});
