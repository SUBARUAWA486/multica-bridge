export const workflow = {
  mode: 'current_chat',
  operations: '优先 MCP；未覆盖的 Multica 操作用本项目 API 类和已配置登录 profile 直接请求接口，不因 MCP 缺少工具而申请应用控制权限。配置位置由 get_status 获取，不打印凭据，不绕过平台鉴权；接口不支持或拒绝时明确报告。',
  task_defaults: '先按需查询 get_task_options。状态默认 todo，负责人默认当前登录用户，优先级默认 low，仅用户明确指定时使用其他优先级；平台项目属性按用户及上下文确定，不猜测 ID；项目区与任务性质标签按 label_selection 一起建议并由用户确认。不能因创建任务而启动平台 agent。',
  label_selection: '新建任务前调用 get_task_options(kind=labels)，一起推荐两类已有标签：一个所属产品/项目区标签（可参考返回的项目标签提示），以及一个最贴切的任务性质标签（如修复、功能、重构、文档，以实际标签为准）。简短说明理由，用一次确认列出两类选择；等待明确确认后才调用 prepare_task 或携带 issue 的 connect_current。项目标签提示只是候选子集，仍须查看完整标签列表推荐任务性质。若某类用户已明确选择，直接复用，只确认缺少的类别；不要把建议、上下文推断或平台项目属性当作确认。不猜 ID、不自动创建标签，不按固定名称硬匹配；无合适性质标签或无法判断时说明并询问是否留空，不强行归类。选择一个项目区标签不限制同时添加性质标签。关联已有任务或重连不重新选标签。用户明确要求某类或全部不设置时遵从。',
  subtasks: '一个聊天只绑定父任务，全部执行记录同步到父任务原 Chat。用 prepare_task(parent_key=父任务key) 新建子任务，随后用子任务 key 调用 update_task；get_task 返回子任务列表。子任务不绑定聊天、不创建 Chat、不启动平台 agent，不复制执行记录。开始子任务时简短说明当前处理项，工作完成设审核中；父任务仅在整体工作就绪时设审核中，不随子任务或每轮输出自动流转。父子任务分别使用精简描述、低优先级和用户确认的项目区标签；同一项目已明确选择可复用，不自动继承任务性质。',
  status_policy: '开始实际执行可设 in_progress，任务工作完成后设 in_review，等待用户审核；不要每轮回复后改变任务状态。只有这两个状态可由模型自行选择；done 及其他状态必须用户明确指定，status_source=user_requested 只能用于实际用户指令。默认创建 todo 不代表已开始执行。',
  description: '任务描述只分摘要和备注。默认仅写摘要（一两句问题与预期结果），不生成空备注。其他补充内容一律归入备注；用户明确要求写备注时可写，模型自行认为需要补充时先向用户展示拟写内容，等待确认后再写入备注，不能仅告知后直接写入。创建和更新都遵守；不自动补充验收、范围、背景或本地信息，不改写既有描述。',
  guidance: '在当前聊天直接工作。创建任务只需标题和必要的简短说明，不新建子聊天，不重述已有背景，不强制填写模板。仅在用户明确要求时同步，不自动绑定管理聊天。',
  available: ['prepare_task：创建或关联任务', 'update_task：独立修改任务字段', 'get_task/get_status：核对任务及镜像状态'],
  sync: '明确要求后 connect_current。用户单独发送停止指令后，先 pause_sync 等 confirmed，再继续本地交流；pending 不等于已停止。用户主动要求恢复时 resume_sync，复用原任务和 Chat，不补传暂停内容。不提供单轮自动恢复。已发送内容无法撤回。',
  title: '成功关联任务后，用 Codex 原生 set_thread_title 为当前对话的原标题加 M- 前缀；已有则不重复，暂停期间保留。不直接修改 Codex 数据库。',
  privacy: '用户输入仅显示“用户消息”；已启用的运行输出继续同步，可能引用用户信息。任务元数据单独发布，不上传完整聊天历史。',
  verification: '创建任务不等于聊天已关联或输出已送达；按服务端读回结果报告，镜像结束不等于业务完成。'
};
// MCP and get_workflow share policy text; tool descriptions keep parameter and ACK semantics.
export const mcpInstructions = Object.values(workflow).filter(value => typeof value === 'string' && value !== workflow.mode).join('\n');
