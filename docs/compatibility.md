# Compatibility

## Runtime

Node.js 24 or later is required for ESM, built-in SQLite, and abort-signal behavior.
There is no build step. The locked SDK is 1.32.1 and Zod is 4.6.7.

## Codex source format

The adapter reads `state_5.sqlite` read-only, using the `threads` table's metadata,
and reads the selected file under `sessions/`. It accepts the JSONL record shapes
exercised in the synthetic fixtures: task_started/task_complete/turn_aborted,
visible message items, function/custom-tool calls and outputs, and turn metadata.
Internal review and subagent threads are rejected. The source file's inode and
cursor are checked; no Codex database or original transcript is modified.

These local record paths and schemas are implementation details, not an official
stable OpenAI API. A changed schema can require adapter updates. No claim is made
that every Codex desktop/CLI version is supported. A passing synthetic fixture is
not a product-version compatibility certificate. Always validate with a disposable
chat on the actual client build before enabling important work.

## Multica

The bridge requires an already-authenticated user profile and routes for task
metadata, child tasks, private agents, daemon runtime registration/heartbeat/claim,
Chat creation, message ingestion, completion, and optimistic task updates.
These include `/api/issues`, `/api/chat/sessions`, `/api/agents`, and `/api/daemon/*`.
They are deployment APIs rather than a guaranteed stable public integration API.

Development integration has been exercised against an existing deployment whose
exact upstream build/version has not been pinned here. This is deliberately **not**
a claim of compatibility with every self-hosted build or Multica cloud. Permissions,
commercial features, endpoint availability, and platform visibility are enforced
by that deployment. Failures should be reported with redacted endpoint/status and
build information, not fixed by widening permissions or recreating remote objects.

## Multiple chats and lifecycle

One process can mirror multiple explicitly selected chats, with separate cursors,
queues and controls. A chat keeps one top-level task and remote Chat; subtask state
is metadata only. Explicit pause and application-quit waiting are distinct states.

If application-presence following is configured, exiting the exact configured main
executable stops network communication, while closing a window alone does not.
Reopening skips content produced while closed. With presence following disabled,
closing Multica does not stop the bridge. This distinction must be configured by
the operator; paths cannot be guessed portably across machines.
