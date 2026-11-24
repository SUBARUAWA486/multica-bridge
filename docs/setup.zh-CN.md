# 本机安装

[English](setup.md)

Bridge 与 Codex 运行在同一台机器上，Multica 单独运行。
不需要构建，也不需要向外暴露 Bridge HTTP 端口。

## 1. 准备环境

下载或克隆仓库，在 Codex 中打开仓库目录。确认 `node --version` 为 24 或以上，
首次安装执行以下命令；已下载或打开仓库时，跳过 clone 和 cd：

```sh
git clone https://github.com/SUBARUAWA486/multica-bridge.git
cd multica-bridge
npm ci
cp config.example.json config.local.json
```

`config.local.json` 已被 Git 忽略。登录 profile 和运行状态放在仓库外。
如果已有安装，保留原配置和状态，不要另建一套运行时。

## 2. 填写配置

编辑 `config.local.json`，用真实部署信息替换示例。
路径必须为绝对路径；JSON 中不要使用字面量 `~` 或 `$HOME`。

| 必填字段 | 填写内容 |
| --- | --- |
| `serverUrl` | Multica 基础 URL；本地测试外优先 HTTPS |
| `workspaceId` / `workspaceSlug` | 目标 Multica 工作区的 UUID 和 URL slug |
| `profilePath` | 已有 Multica 登录 profile JSON，包含 `token` |
| `codexHome` | 包含 `state_5.sqlite` 和 `sessions/` 的本地 Codex 目录 |
| `stateDir` | 仓库外专用私有状态目录；升级时保留 |

复用已有 Multica 登录。Agent 应先检查已有本机配置，通过已认证接口核对工作区，
只询问缺少的信息或需要选择的目标，不输出 token、不猜工作区 ID、不擅自切换服务器。
找不到登录 profile 或所需 Codex 记录时，明确报告缺少的前提，不能声称安装成功。
不要把 token 复制进 Bridge 配置。

其他字段可先保留示例值：

- `localWorkspaceRoot`：需要在上传内容中隐藏的本地项目路径。
- `toolPayloads`：是否上传工具参数和结果，默认关闭。
- `projectLabelPrefix`：可选的项目区标签前缀提示。
- `privacy`：可选的邮箱、内网地址过滤，默认关闭。
- `clientPresence`：默认关闭。要退出 Multica 应用后断开通信，需开启并填写
  实际主进程的绝对路径。关闭窗口不等于退出应用；重开后不补传关闭期间的内容。

也可以把配置放在仓库外，通过 `MULTICA_BRIDGE_CONFIG` 指定其绝对路径；
MCP 和 CLI 必须使用相同配置。不设置时固定读取本仓库的 `config.local.json`，
不取决于当前聊天在哪个目录。

## 3. 注册 MCP

在 Codex 客户端的 MCP 配置中添加名为 `multica_bridge` 的 stdio 服务。
替换下列占位路径，Node 可执行文件须为 24 或以上版本：

Codex 默认使用 `~/.codex/config.toml`；项目级 `.codex/config.toml` 仅在受信任项目生效。
希望在其他项目聊天中也能调用时，使用用户级配置。详见 [Codex MCP 官方说明](https://developers.openai.com/codex/mcp)。

```toml
[mcp_servers.multica_bridge]
command = "/absolute/path/to/node"
args = ["--disable-warning=ExperimentalWarning", "/absolute/path/to/multica-bridge/src/mcp.mjs"]

[mcp_servers.multica_bridge.env]
MULTICA_BRIDGE_CONFIG = "/absolute/path/to/multica-bridge/config.local.json"
```

这里只是配置片段，不覆盖其他 MCP 项。Agent 应采用客户端支持的注册方式，
完成后重新连接 MCP，必要时重启 Codex。
不要把 `src/mcp.mjs` 当作后台守护进程启动：客户端负责它的 stdio 连接。
独立的 Bridge daemon 由 `start_bridge` 或同步控制操作启动。

已安装 Codex CLI 时，也可以用以下命令注册同一服务，无需手工编辑 TOML
（已有同名配置时先检查，不要重复覆盖）：

```sh
codex mcp add multica_bridge \
  --env MULTICA_BRIDGE_CONFIG=/absolute/path/to/multica-bridge/config.local.json \
  -- /absolute/path/to/node --disable-warning=ExperimentalWarning \
  /absolute/path/to/multica-bridge/src/mcp.mjs
```

## 4. 验证连接

让 Agent 依次调用 `get_workflow`、`get_status`、`get_task_options(kind=labels)`、
`start_bridge`，再查看 `get_status`：

- 服务器和工作区符合选择，标签接口请求成功。
- daemon 健康信息及时更新，没有相关注册错误。
- 开启应用跟随但 Multica 未打开时，等待状态正常；打开应用后再验证连接。

只有本地 status 或工具发现成功，不代表认证成功，还需要已认证接口请求成功。

最后用一个可丢弃的聊天和任务验证：明确要求连接，等 `confirmed`，输出一条无敏感
信息的回复，再用 `get_sync_status` 的 `verify_remote=true` 核对服务端记录。
随后暂停、等 `confirmed`、再恢复，确认复用了原 Chat。
服务端读回只证明已保存，不等于客户端页面显示验证。
不要绑定安装对话，也不要上传之前的历史讨论。

## 手工备用路径与升级

在仓库根目录执行，需要时设置相同的 `MULTICA_BRIDGE_CONFIG`：

```sh
node --disable-warning=ExperimentalWarning src/cli.mjs workflow
node --disable-warning=ExperimentalWarning src/cli.mjs status
node --disable-warning=ExperimentalWarning src/cli.mjs start
node --disable-warning=ExperimentalWarning src/cli.mjs shutdown
```

`shutdown` 只是请求 daemon 退出，重启前要确认已经停止；不会停止 Codex 执行。
同步控制可手工执行 `node --disable-warning=ExperimentalWarning src/cli.mjs sync pause.json`，
其中 `pause.json` 为 `{"action":"pause","thread_id":"<当前聊天 UUID>"}`。
恢复使用 `"action":"resume"`；首次连接使用 `"action":"connect"` 并加上已有任务 `"key"`。
暂停请求返回 `pending` 时，用 `operation <request-id>` 继续检查，直到 `confirmed`。

CLI 的任务与同步操作还可接收本地 JSON 参数文件，参数结构见 `src/mcp.mjs`；
`workflow` 无需登录即可读取约定。MCP 未覆盖的 Multica 操作，由 Agent 根据
`get_status.apiAccess` 使用现有 API 类请求，失败时明确报告，
不因缺少工具而申请应用控制权限。

更新传输代码前，先暂停正在同步的聊天并请求 daemon 退出。
保留配置和 `stateDir`，更新源码，执行 `npm ci`，再启动 Bridge 并检查状态。
工具或指令有变化时重新连接 MCP。daemon 停止后不能处理暂停确认；
手动暂停的聊天重启后仍需明确要求恢复。

记录格式与接口限制见[兼容说明](compatibility.md)，同步敏感工作前请阅读[安全说明](../SECURITY.md)。
