# Security and privacy

This is a local transport tool with best-effort redaction, not a DLP system or
filesystem sandbox. It reads explicitly selected Codex records and uploads
eligible visible output to your configured Multica server using your credentials.

## Reporting

Do not post credentials, transcript excerpts, private server addresses, or live
workspace/task IDs in public issues. If this repository has GitHub private
vulnerability reporting enabled, use its Security tab. Otherwise first request a
private reporting channel from the maintainer without disclosing the vulnerability
or private data. No private reporting service or response-time guarantee is
currently provided.

## Operational boundaries

- Keep the login profile and `stateDir` outside any public repository; restrict
  filesystem access to the local user. Local state can contain pending output.
- Use HTTPS outside a trusted local test network. Content reaches the configured
  server; transport redaction does not make the server untrusted-safe.
- A pause is effective only after the daemon returns `confirmed`. Already-sent or
  in-flight content cannot be retracted. Send pause as a standalone instruction.
- User input is replaced by a placeholder, but replies and tool output can quote
  it. Known secret patterns and local paths are filtered; business secrets,
  arbitrary encodings, and unknown formats may remain.
- Internal-address and email masking are optional and disabled by default, because
  masking URLs may break task/Chat links. Profile tokens remain in the HTTP auth
  header for authentication; they are masked when found in business content.
- IDs and optimistic-concurrency bases are not rewritten. A description-base
  value can resend existing remote content to the same server.
- Multica controls server-side visibility. A private mirror agent is not a promise
  that server operators cannot access stored data. Audit your deployment.
- The bridge does not patch Codex permissions, launch models, or authorize access
  to unrelated projects. Local filesystem permissions remain the operating
  system's responsibility.

Only the current source snapshot is maintained; compatibility with every Codex
build or Multica deployment has not been established. See docs/compatibility.md.
