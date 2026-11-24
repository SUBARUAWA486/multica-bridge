# Testing

## Local regression suite

```sh
npm ci
npm test
```

The suite needs no login or deployment config. It creates synthetic Codex metadata
and transcript files, temporary state, and loopback HTTP fixtures. It covers
idempotency, fences, pause/resume, application presence, remote-parent validation,
multiple chats sharing a runtime, redaction, task metadata, and MCP discovery.
Do not replace fixtures with real customer or personal records.

## Development integration

Create a private development config outside the repository from config.example.json,
with `environment: "development"`, an existing development login profile, and a
disposable workspace. Never use production. The integration script disables
application-presence following only inside its isolated synthetic test config.

```sh
MULTICA_BRIDGE_CONFIG=/absolute/path/to/private/development.json \
MULTICA_BRIDGE_TEST_DIR=/absolute/path/to/private/synthetic-run \
node --disable-warning=ExperimentalWarning scripts/window-integration.mjs \
  --development --server-confirm https://development.example.com
```

The directory must be new for each run. The script starts an independent MCP
process and bridge daemon, and creates synthetic tasks, a private mirror identity,
a Chat, and a runtime. It writes `result.json` on success and a
`cleanup-manifest.json` with known IDs even on failure. It does not launch a model.

The script stops its local daemon but **does not delete remote data**. Review the
cleanup manifest and remove only those synthetic objects through the development
server's supported APIs; deletion permissions and API availability vary. Archive
the synthetic agent when permanent deletion is unavailable. Never use a broad
workspace purge as test cleanup, and keep the manifest until cleanup is verified.

## Public snapshot check

Stage the intended files, regenerate dependency notices after dependency changes,
and run:

```sh
npm run licenses
npm run check:release
npm pack --dry-run --json
```

The release check is a lightweight hygiene check, not a legal opinion or complete
secret scanner. It reads staged Git blobs, rejects tracked worktree/index differences and package
files outside that checked index, and checks package inclusion rules. Stage all
intended edits before running it; unstaged edits must be resolved first. It does not
scan unrelated local stores or upload anything.

## Secret scanning before publication

`npm run check:release` checks every staged file for the shared token-format rules,
including tests and license files, then scans commit messages and unique file
versions across all locally reachable branches and tags. CI fetches full history;
shallow clones are rejected. Run `npm run scan:history` for the history check alone.
Fetch any remote refs intended for publication first; absent refs, unreachable
objects, reflogs and private recovery archives are outside this scope.

Rules include Multica tokens, AWS access/session keys and explicitly named secret-access-key values, GitHub/GitLab, OpenAI,
Anthropic, Slack, Stripe, Google API keys, JWTs and private-key blocks. This is a
best-effort format scan, not the complete Gitleaks engine or a guarantee against
opaque, encoded, split or unknown credentials. No real login profile is read.
Failures report file/commit locations without printing matched values.

Synthetic credential exemptions in `scripts/scan-secrets.mjs` bind an exact path
to a SHA-256 of the entire matched value. There is no test-directory credential
bypass. Review each exemption; prefer constructing synthetic strings in tests.
Historical incomplete PEM fixtures have exact exemptions so no history rewrite
is needed. Paths/private addresses in synthetic tests keep their existing separate
presentation-data exceptions. Never exempt a real credential: revoke it and decide
how to clean affected history before publication.
