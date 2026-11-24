import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, projectDir } from './config.mjs';
import { start, status, taskStatus, syncControl, syncStatus, manageProfile } from './control.mjs';
import { getProfile } from './profiles.mjs';
import { prepareTask, updateTask, taskContext, taskOptions } from './tasks.mjs';
import { workflow, mcpInstructions } from './workflow.mjs';
import { readJson } from './storage.mjs';
import path from 'node:path';
import { operation } from './operations.mjs';

const server = new McpServer({ name: 'multica-bridge', version: readJson(path.join(projectDir, 'package.json')).version }, { instructions: mcpInstructions });
function tool(name, description, schema, fn, readOnlyHint = false, needsConfig = true) {
  server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint, destructiveHint: false, openWorldHint: true } }, async args => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await fn(needsConfig ? loadConfig() : undefined, args)) }] }; }
    catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
  });
}
const issue = z.object({ title: z.string().min(1).max(500), description: z.string().optional(), status: z.string().min(1).optional(), assignee_type: z.literal('member').optional(), assignee_id: z.string().uuid().optional(), project_id: z.string().uuid().optional(), priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional().describe('默认 low（低）；只有用户明确指定时才传其他优先级，不由模型推断。'), label_ids: z.array(z.string().uuid()).optional() }).strict();
const resources = z.array(z.object({ alias: z.string().min(1), path: z.string(), purpose: z.string().optional() })).default([]);
const statusSource = z.enum(['automatic', 'user_requested']).default('automatic').describe('只有用户明确指定该状态时才使用 user_requested；模型自行判断仅允许进行中/审核中，完成工作后进入审核中。');
const controls = { thread_id: z.string().uuid(), request_id: z.string().uuid().optional(), expected_generation: z.number().int().nonnegative().optional() };
tool('get_status', '查看 bridge 目标、连接及绑定状态，不返回凭据或任务交接提示。', {}, c => status(c), true);
tool('get_workflow', '简短说明当前聊天同步的用法及边界，无需每轮重复读取。', {}, () => workflow, true, false);
tool('get_task_options', '按需查询当前工作区可用状态、项目、标签或成员。负责人使用 user_id；项目工作流可能限制状态，最终以创建接口校验为准。不返回邮箱或凭据。', { kind: z.enum(['statuses', 'projects', 'labels', 'members']) }, (c, a) => taskOptions(c, a.kind), true);
tool('prepare_task', '创建或关联任务，不启动同步。parent_key 创建子任务；issue_id 关联已有任务。相同 key 返回原任务、不覆盖属性；返回初始化属性及警告。创建前遵守 get_workflow 的标签选择与描述规则。', {
  key: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), parent_key: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional().describe('创建子任务时指定已确认的顶层父任务 key；子任务不绑定 Chat，不启动 agent。'), issue_id: z.string().uuid().optional(), issue: issue.optional(),
  resources, status_source: statusSource, profile_key: z.string().optional(), publish_results: z.boolean().default(false)
}, (c, a) => prepareTask(c, a));
tool('connect_current', '将当前聊天绑定顶层任务；issue 可同时创建任务，否则使用已有 key。thread_id 必须来自当前聊天。confirmed 后的输出才进入同步窗口；pending 用 get_operation 查询。子任务绑定会被拒绝。', {
  ...controls, key: z.string(), issue: issue.optional(), resources, status_source: statusSource, publish_results: z.boolean().default(false)
}, (c, a) => syncControl(c, { ...a, action: 'connect' }));
tool('pause_sync', '第一动作调用，然后等待 confirmed，才可输出私密内容。停止本地后续发送并丢弃未发队列，不停止 Codex。pending 不等于成功；已发送/在途旧请求不能撤回。Multica 关闭时也可确认本地停止，远端旧片段可能待结算。', controls, (c, a) => syncControl(c, { ...a, action: 'pause' }));
tool('resume_sync', '恢复同一聊天对应的原任务及原 Multica Chat，从确认时刻继续，不补传断开期间内容。不会因重连新建任务或 Chat。', controls, (c, a) => syncControl(c, { ...a, action: 'resume' }));
tool('get_operation', '查询连接、暂停或恢复操作的确认状态，pending 时继续等待，不能当作成功。', { request_id: z.string().uuid() }, (c, a) => operation(c, a.request_id), true);
tool('get_sync_status', '查看指定聊天的同步窗口、暂停/恢复、最后服务端确认时间；可选择 API 读回验证，API 可读不等于客户端已显示。', { thread_id: z.string().uuid(), verify_remote: z.boolean().default(false) }, (c, a) => syncStatus(c, a.thread_id, a.verify_remote), true);
tool('get_task', '查看任务、直接子任务（含可用本地 key）与已关联的镜像状态，不返回历史交接长文或本地资源路径。', { key: z.string() }, (c, a) => taskStatus(c, a.key), true);
tool('get_task_context', '仅在缺少项目位置时按需读取本机资源映射，不含角色加载或交接模板。', { key: z.string() }, (c, a) => taskContext(c, a.key), true);
tool('update_task', '用 key 更新指定任务或子任务字段，使用版本保护和 suppress_run。遵守 get_workflow 的状态授权及描述规则，不启动平台 agent。', {
  key: z.string(), status_source: statusSource, fields: z.object({ title: z.string().optional(), description: z.string().optional(), status: z.string().optional(), priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional().describe('只有用户明确指定时才修改优先级。'), project_id: z.string().uuid().nullable().optional() }).strict()
}, (c, a) => updateTask(c, a.key, a.fields, undefined, { statusSource: a.status_source }));
tool('start_bridge', '启动本地传输后台；不自动发现工作区聊天，不启动模型。', {}, c => start(c));
tool('get_profile', '按需查看镜像身份配置；不需要执行模型重新加载，不改变原生 Codex 设置。', { key: z.string(), version: z.number().int().positive().optional() }, (c, a) => getProfile(c, a.key, a.version), true);
tool('save_profile', '管理镜像身份配置，使用版本保护；不会切换当前模型或新建执行聊天。', {
  key: z.string(), expected_version: z.number().int().positive().optional(), make_default: z.boolean().default(false),
  settings: z.object({ name: z.string().min(1).max(100).optional(), description: z.string().max(180).optional(), instructions: z.string().max(50000).optional(), model: z.string().max(100).optional(), effort: z.string().max(50).optional(), skillPaths: z.array(z.string()).optional() })
}, (c, a) => manageProfile(c, a.key, a.settings, a.expected_version, a.make_default));
await server.connect(new StdioServerTransport());
