# Contributing

This project is an unofficial integration. Please keep changes small and explain
observable behavior, validation, and compatibility effects.

## Development

Use Node.js 24 or later. Run `npm ci` and `npm test`. The unit suite uses synthetic
records and local HTTP fixtures, and does not require a Multica account. Never
run production work as a test or commit authentication profiles, chat transcripts,
workspace identifiers, runtime state, screenshots, or private deployment URLs.

For dependency changes, run `npm audit --omit=dev` and `npm run licenses` and review the complete generated
diff. Before submitting, stage only intended public files and run
`npm run check:release`. An integration test against a disposable development
server is described in docs/testing.md. It is not part of public CI.

## Compatibility and safety

Keep CLI/MCP entry points and persistent state compatible unless a migration is
explicitly documented. Never widen synchronization scope, resume automatically
after an explicit pause, start a second model, or silently replace remote IDs.
Keep concurrency guards, retry fences, and upload redaction intact. Update the
focused regression tests and documentation for behavior changes.

## Rights and attribution

By submitting a contribution for inclusion, you agree to license your contribution
under the project's MIT License, subject to any explicitly preserved third-party
notices. Submit only work you have the right to license. Do not copy code from
company repositories or Multica's separately licensed implementation without
reviewing the relevant license and preserving required notices. See
[provenance](docs/provenance.md) and [compliance](docs/compliance.md).

No CLA or legal certification is implied. Security issues should follow
[SECURITY.md](SECURITY.md); do not include real secrets in a public issue.
