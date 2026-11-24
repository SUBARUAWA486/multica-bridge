# Local setup

[简体中文](setup.zh-CN.md)

The bridge runs on the same machine as Codex. Multica runs separately. There is
no build step and no bridge HTTP port to expose.

## 1. Prepare

Download or clone this repository and open its directory in Codex. Check
`node --version` is 24 or later, then run the following. Skip clone/cd if the repository is already open:

```sh
git clone https://github.com/SUBARUAWA486/multica-bridge.git
cd multica-bridge
npm ci
cp config.example.json config.local.json
```

`config.local.json` is ignored by Git. Keep login profiles and runtime state
outside the repository. If an installation already exists, preserve its private
config and state rather than creating a second runtime.

## 2. Configure

Edit `config.local.json`; replace the example values with actual deployment data.
Paths must be absolute; do not use literal `~` or `$HOME` in JSON.

| Required field | Value |
| --- | --- |
| `serverUrl` | Multica base URL; prefer HTTPS outside local testing |
| `workspaceId` / `workspaceSlug` | UUID and URL slug of the intended Multica workspace |
| `profilePath` | Existing Multica login profile JSON containing `token` |
| `codexHome` | Local Codex directory containing `state_5.sqlite` and `sessions/` |
| `stateDir` | Dedicated private directory outside this repository; retain it across upgrades |

Use your existing Multica login. The agent should inspect available local setup
and authenticated workspace metadata, ask only for missing choices, and never
print the profile's token. Do not guess workspace IDs or silently choose another
server. If the profile or required records cannot be found, stop and report the
missing prerequisite. Do not copy the token into bridge config.

Optional settings can stay at their example values:

- `localWorkspaceRoot`: local project path to mask in uploaded output.
- `toolPayloads`: include tool arguments/results; defaults to false.
- `projectLabelPrefix`: optional hint for your workspace's project-label convention.
- `privacy`: opt-in email/private-address masking; defaults to false.
- `clientPresence`: defaults to disabled. To disconnect on Multica exit, enable
  it and supply the actual absolute main executable paths. Closing a window is
  not exiting. Reopening skips content produced while the application was closed.

For a config outside this repository, set `MULTICA_BRIDGE_CONFIG` to its absolute
path in both MCP and CLI environments. It otherwise defaults to `config.local.json`
in this repository, regardless of the calling chat's directory.

## 3. Register MCP

Add a stdio MCP server named `multica_bridge` in your Codex client's MCP configuration.
Use these values; replace placeholder paths and use a Node 24+ executable:

Codex uses `~/.codex/config.toml` by default; project-scoped `.codex/config.toml`
requires a trusted project. Use user-level registration for access from other
project chats. See the [official Codex MCP guide](https://developers.openai.com/codex/mcp).

```toml
[mcp_servers.multica_bridge]
command = "/absolute/path/to/node"
args = ["--disable-warning=ExperimentalWarning", "/absolute/path/to/multica-bridge/src/mcp.mjs"]

[mcp_servers.multica_bridge.env]
MULTICA_BRIDGE_CONFIG = "/absolute/path/to/multica-bridge/config.local.json"
```

This is a configuration fragment; preserve unrelated MCP entries. Have the agent
use the client's supported registration mechanism, then reconnect MCP (or restart
Codex if needed). Do not start `src/mcp.mjs` as a background daemon: the client
owns its stdio connection. The separate bridge daemon is started by `start_bridge`
or sync controls.

If Codex CLI is installed, this registers the same server without manually
editing TOML (inspect any existing entry before replacing it):

```sh
codex mcp add multica_bridge \
  --env MULTICA_BRIDGE_CONFIG=/absolute/path/to/multica-bridge/config.local.json \
  -- /absolute/path/to/node --disable-warning=ExperimentalWarning \
  /absolute/path/to/multica-bridge/src/mcp.mjs
```

## 4. Verify

Ask the agent to call `get_workflow`, `get_status`, `get_task_options(kind=labels)`,
and `start_bridge`, then inspect `get_status` again:

- Server/workspace match your choice; the label request succeeds.
- The daemon reports fresh health and no relevant registration error.
- If presence following is enabled and Multica is closed, waiting is expected;
  open Multica to verify connectivity.

Local status alone does not prove authentication. MCP discovery works without
credentials; successful authenticated requests are also needed.

Finally use a disposable chat/task: explicitly request connection, wait for
`confirmed`, produce a harmless reply, and check server readback with
`get_sync_status` using `verify_remote=true`. Then pause, wait for `confirmed`,
and resume. Confirm the same remote Chat is retained. Readback verifies storage,
not client rendering. Do not bind the installation chat or upload earlier history.

## Manual fallback and updates

From the repository root (set the same `MULTICA_BRIDGE_CONFIG` if needed):

```sh
node --disable-warning=ExperimentalWarning src/cli.mjs workflow
node --disable-warning=ExperimentalWarning src/cli.mjs status
node --disable-warning=ExperimentalWarning src/cli.mjs start
node --disable-warning=ExperimentalWarning src/cli.mjs shutdown
```

`shutdown` requests daemon exit; confirm it stopped before restarting. It does not
stop Codex execution.

For manual sync control, run `node --disable-warning=ExperimentalWarning src/cli.mjs sync pause.json`.
The file contains `{"action":"pause","thread_id":"<current chat UUID>"}`.
Use `"action":"resume"` to resume, or `"action":"connect"` with an existing task
`"key"` for the first connection. If pause returns `pending`, poll
`operation <request-id>` until `confirmed`.

CLI task/sync operations also accept local JSON files;
argument schemas are in `src/mcp.mjs` and the workflow is available without login.
For Multica operations not exposed as tools, the agent can use `get_status.apiAccess`
and the existing API client. Report API errors; do not request application control
just because a tool is missing.

Before updating transport code, pause active syncs and request daemon shutdown.
Preserve configuration and `stateDir`, update source, run `npm ci`, then start the
bridge and inspect status. Reconnect MCP after tool or instruction changes.
A stopped daemon cannot process pause confirmations. Explicitly paused chats
remain paused until you ask to resume.

See [compatibility](compatibility.md) for supported record shapes and API limits,
and [security](../SECURITY.md) before syncing sensitive work.
