# Multica Bridge

[English](README.md)

独立、非官方的本地 Codex → Multica 同步桥。直接在当前 Codex 聊天工作，按需将后续可见输出同步到 Multica 任务，不调用第二个模型、不另建执行聊天。

本项目不代表 OpenAI 或 Index Labs，不包含 Codex、Multica 界面、服务端或企业版实现。源码按 MIT 提供；上游产品仍适用各自协议。代码来源与限制见 [来源说明](docs/provenance.md) 和 [合规核验记录](docs/compliance.md)。

## 安装

需要 Node.js 24+、本地 Codex 记录，以及具备相应接口权限的 Multica 部署。

```sh
npm ci
cp config.example.json config.local.json
```

修改本机配置中的服务器 URL、工作区 UUID/slug、已有登录 profile 路径、Codex 目录与私有 `stateDir`，均按你的部署填写。凭据不写进 bridge 配置。`MULTICA_BRIDGE_CONFIG` 可指定仓库外配置，运行状态也应放在仓库外。示例不包含真实环境信息，默认不上传工具参数/结果。

MCP stdio 命令为 `node`，参数为 `--disable-warning=ExperimentalWarning` 和 `/absolute/path/to/multica-bridge/src/mcp.mjs`；按需设置 `MULTICA_BRIDGE_CONFIG`。工具发现及 `get_workflow` 不需要登录，实际操作需要有效配置。CLI 也可用于启停、任务与同步控制，完整参数见英文 README。

`clientPresence.enabled` 默认关闭；此时退出 Multica 不会停止 bridge 通信。要跟随应用退出，必须开启并填写当前机器实际的主进程绝对路径，不能误选 Electron helper。关闭窗口不等于退出应用。

## 使用

- 创建任务：先建议并由你选择现有项目区标签；已明确选择不重复问。`projectLabelPrefix` 是可选的本机命名提示，不强制特定前缀。
- 创建不代表同步。明确要求后调用 `connect_current`，`confirmed` 之后才上传；之前讨论不补传。
- 单独发送停止指令：先 `pause_sync` 并等待 `confirmed`，再输出私密内容。已发送或在途内容不可撤回。
- 明确恢复后 `resume_sync` 复用原任务和 Chat，不补传暂停内容。
- 新任务默认人员负责人、低优先级和 `todo`；模型可自行设进行中或审核中，已完成及其他状态须用户明确要求。任务描述默认只写摘要，备注需用户要求或先确认模型拟补充的内容。
- 一个聊天只绑定一个顶层任务。子任务用于明确范围、独立管理属性和状态，全部对话留在父任务 Chat，不启动平台 agent。相互独立的并行工作用不同 Codex 聊天。

## 隐私和兼容性

用户输入上传为“用户消息”，可见回复和启用的业务工具输出仍可能引用用户信息。常见凭据、私钥、连接串和本地路径在上传前尽力遮盖。邮箱和内网地址过滤是可选开关，默认关闭以免破坏链接；不能保证识别所有业务机密或编码后的秘密。服务器仍可保存和访问已收到的内容。详见 [安全边界](SECURITY.md)。

Codex 的 SQLite/JSONL 和使用的 Multica 接口并非稳定兼容承诺；没有声明支持全部客户端版本或所有云端/自托管部署。先用可丢弃的开发聊天验证，详见 [兼容说明](docs/compatibility.md)。创建结果未知时先对账，不盲目新建；API 已保存不代表页面已刷新。

## 开发与许可

`npm test` 使用合成记录和本机服务，不依赖个人配置。开发环境集成、生成依赖声明与公开文件检查见 [测试说明](docs/testing.md)。

源码：[MIT](LICENSE)；第三方：[NOTICE](NOTICE)、[依赖许可证](THIRD_PARTY_NOTICES.md)。[贡献规范](CONTRIBUTING.md) 与 [合规记录](docs/compliance.md) 说明来源、权利与发布边界。当前保留 `private: true` 防止误发布 npm；本次整理不会自动建立公共仓库或发布服务。公开前仍需确认有权发布，包括可能涉及的公司、客户和保密义务。

本工具基于 [Multica](https://github.com/multica-ai/multica) 的 HTTP API 构建，独立维护。
MIT 允许本工具商用、修改和再分发，要求保留版权与许可声明；不要求使用者公开其修改。
这不包含 Multica 或 Codex 的授权。Multica 的[自身许可](https://github.com/multica-ai/multica/blob/main/LICENSE)
对托管、商业嵌入和署名另有条件，须分别遵守。具体方案见[发布与许可政策](docs/compliance.md#publishing-policy)。
