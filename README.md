# Multica Bridge

[简体中文](README.zh-CN.md)

An **unofficial, local Codex-to-Multica mirror**. Work in your existing Codex
chat; explicitly connect it to a Multica task when you want visible output to be
mirrored. The bridge does not run a second model or create a second Codex chat.

This project is independent of OpenAI and Index Labs. It does not include Codex,
Multica, their product interfaces, or any enterprise implementation. MIT covers
this repository's contributions and preserved MIT rule adaptations, not the
licensing or service terms of those products. See [NOTICE](NOTICE) and the
[readiness review](docs/compliance.md).

## What it does

- Creates or associates tasks, and manages child-task metadata under one parent.
- Mirrors visible replies and optionally business-tool payloads from an explicitly
  selected local Codex transcript. User input becomes the fixed `用户消息` placeholder.
- Confirms pause/resume boundaries, reuses the same remote Chat, and skips private
  windows. Multiple chats have separate cursors and queues in one bridge process.
- Applies best-effort credential/path redaction before upload; task IDs and
  concurrency guards remain intact.
- Optionally stops communication while the configured Multica application is not
  running. Closing a window is different from exiting its main process.

It does not automatically discover directories/chats, mirror internal review or
subagent chats, route messages to multiple tasks, or automatically complete tasks.

## Requirements

- Node.js **24+**, npm, and a local Codex installation that writes the supported
  SQLite/JSONL shapes.
- A separately operated Multica deployment, an authenticated local profile, and
  permission to use the required task/Chat/daemon APIs.
- A compatible MCP stdio client, or the CLI for transport control.

Codex record formats and the Multica endpoints used here are implementation
interfaces, not promised stable integration contracts. Exact supported product
versions have not been pinned; validate against a disposable chat first. See
[compatibility](docs/compatibility.md).

## Setup

```sh
npm ci
cp config.example.json config.local.json
```

Edit the local file before starting. Use absolute paths and keep authentication
and runtime state outside the public repository:

| Field | Purpose |
| --- | --- |
| `serverUrl` | Your Multica URL; prefer HTTPS outside local testing |
| `workspaceId`, `workspaceSlug` | An existing workspace UUID and URL slug |
| `profilePath` | Existing local Multica profile JSON containing `token`; no token in bridge config |
| `codexHome` | Codex metadata directory containing `state_5.sqlite` and `sessions/` |
| `stateDir` | Private directory for bindings, queued output, operation logs and cursor state |
| `localWorkspaceRoot` | Optional local path to hide in uploaded text |
| `toolPayloads` | Whether tool arguments/results are included; example defaults to **false** |
| `projectLabelPrefix` | Optional naming hint for project-area labels; empty means no fixed convention |
| `clientPresence` | Optional exact main-executable paths and quit-following policy |
| `privacy` | Optional email/internal-address masking; disabled by default to preserve links |

`MULTICA_BRIDGE_CONFIG` selects another private config file. When
`clientPresence.enabled` is false, exiting Multica does **not** disconnect the
bridge. To opt into quit-following, set it true and list the exact absolute paths
of your installation's main executable. Do not guess paths to helper processes.

Configure your MCP client's stdio server with:

- Command: `node`
- Arguments: `--disable-warning=ExperimentalWarning`, `/absolute/path/to/multica-bridge/src/mcp.mjs`
- Optional environment: `MULTICA_BRIDGE_CONFIG=/absolute/path/to/private/config.json`

MCP discovery and `get_workflow` work without deployment credentials. Operations
that contact Multica or read bindings require valid configuration. Reconnect MCP
after tool/instruction changes; restart the bridge after transport-code updates.

## Everyday use

1. Ask to create a task. The model recommends a project-area label from the actual
   workspace catalog and waits for your choice unless already explicit. Creation
   alone does not enable synchronization.
2. Explicitly request synchronization. `connect_current` returns `confirmed` or an
   operation ID to poll. Only subsequent eligible output is uploaded. The caller
   adds `M-` to the existing Codex title using the client's native title tool.
3. Send a standalone pause instruction. Wait for `pause_sync` to return
   **`confirmed` before private output**. Pending, failed, and confirmed are distinct.
4. Explicitly resume when ready. `resume_sync` keeps the original task/Chat and does
   not upload the paused interval. Already-sent content cannot be recalled.

New tasks default to the authenticated human owner, low priority, and `todo`.
The model may choose `in_progress` and `in_review`; `done` or other transitions
require an explicit user instruction (`status_source=user_requested`). This field
records the caller's declaration; it is not proof of natural-language consent.
Descriptions default to a concise summary. Notes require a user request or prior
confirmation of the model's proposed addition.

For related work, `prepare_task(parent_key=...)` creates child tasks with separate
keys. Their titles, summaries, labels and states define scope; all transcript
stays in the parent Chat. Children do not start platform agents or get mirror
Chats. Parent/child status is not automatically propagated. Use separate Codex
chats for unrelated parallel work.

Task creation can succeed even if its response is lost. Do not retry by creating
another key; inspect the stored outcome and reconcile with the known issue ID.
Attribute mismatches report a committed task ID for inspection. API readback is
not confirmation that the UI refreshed.

## Tools and CLI

| Purpose | MCP tools |
| --- | --- |
| Transport | `connect_current`, `pause_sync`, `resume_sync`, `get_operation`, `get_sync_status` |
| Tasks | `prepare_task`, `get_task_options`, `get_task`, `update_task`, `get_task_context` |
| Maintenance | `get_status`, `get_workflow`, `start_bridge`, `get_profile`, `save_profile` |

```sh
node --disable-warning=ExperimentalWarning src/cli.mjs workflow
node --disable-warning=ExperimentalWarning src/cli.mjs status
node --disable-warning=ExperimentalWarning src/cli.mjs start
node --disable-warning=ExperimentalWarning src/cli.mjs shutdown
```

Other CLI commands take local JSON argument files: `prepare-task <file>`,
`update-task <key> <file>`, `sync <file>` (connect/pause/resume),
`operation <request-id>`, `sync-status <thread-id>`, `task <key>`,
`task-context <key>`, `profile <key>`, and `save-profile <key> <file>`.
Stopping transport does not stop Codex execution. Missing MCP functionality can
use the same authenticated API client identified by `get_status.apiAccess`, without
requiring application-control access or printing credentials.

## Privacy

The selected Codex file is read locally; eligible visible text goes to **your
configured server**, which controls storage and visibility. Tool output may quote
user input or include business-sensitive information. Redaction is best effort,
not semantic confidentiality, encryption from the server, or a filesystem sandbox.
Keep state/config private and follow [SECURITY.md](SECURITY.md). Historical server
records, logs and backups are not cleaned by this feature.

## Development and license

```sh
npm test
npm run licenses
# Stage intended public files before the snapshot check:
npm run check:release
```

Tests use synthetic data and loopback services, with no user configuration. Real
server integration is development-only and described in [testing](docs/testing.md).
A small CI workflow runs tests and public-snapshot checks; it needs no secrets.

- [Architecture](docs/architecture.md)
- [Source provenance](docs/provenance.md) and [dependency notices](THIRD_PARTY_NOTICES.md)
- [Contribution guide](CONTRIBUTING.md), [security policy](SECURITY.md)
- [MIT License](LICENSE) and [third-party attribution](NOTICE)

This is a pre-release source snapshot. `private: true` intentionally prevents
accidental npm publication. No hosted service, public repository, or npm package
is created by these scripts. Confirm publication rights and review the remaining
items in [compliance](docs/compliance.md) before publishing.
