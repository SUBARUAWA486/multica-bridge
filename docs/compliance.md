# Open-source readiness review

Review date: 2026-11-24. Scope: the proposed public source snapshot and locked
Node dependency graph. This is an engineering review record, not a certificate,
lawyer's opinion, or assurance that third parties will never assert rights.

| Area | Result | Evidence / limit |
| --- | --- | --- |
| Repository license | MIT added | LICENSE and package.json; covers contributors' rights only |
| Direct dependencies | MIT | Installed MCP SDK and Zod license files |
| Transitive dependencies | 95 locked entries: MIT, ISC, BSD-2-Clause, BSD-3-Clause | Generated THIRD_PARTY_NOTICES.md; notices check fails on unknown licenses or missing text |
| Dependency security advisory check | npm audit reported 0 known vulnerabilities after upgrading Zod to 4.6.7 | Initial Zod 3 finding GHSA-mrhx-c7xc-m3w5 addressed; point-in-time registry result, not a complete security audit |
| Adapted source rules | Gitleaks MIT | Fixed commit, adaptation scope and complete license in provenance/NOTICE/licenses |
| Multica source redistribution | No Multica implementation or enterprise directories bundled in this snapshot | Prior source consultation disclosed in provenance; not a legal clean-room finding |
| Branding | Unofficial relationship stated; no logos bundled | README and NOTICE; no trademark license implied |
| Local information | Private config/state excluded; examples use synthetic values | Release checker plus explicit package allowlist; manually inspect any new examples |
| Git history | Public repository initialized anew after verified private backup | Fresh root commit; previous private commits are not imported |
| Service / employment rights | Requires maintainer confirmation | Not determined by dependency licenses or automated checks |
| Security / patents / privacy law | No general certification | SECURITY.md states transport and redaction limits |

## Third-party product terms

Multica's upstream repository uses the **Multica License**, which combines
Apache-2.0 text with additional conditions, and separate terms for enterprise
files. It must not be represented as plain Apache-2.0. See the
[official license](https://github.com/multica-ai/multica/blob/main/LICENSE).

This project does not grant rights to redistribute Multica, operate a hosted
Multica service, bypass commercial licensing, or use official branding. The
permissibility of a particular integration or service depends on what is actually
copied, distributed, operated, and agreed with the relevant rightsholder.
Codex use is likewise subject to the user's applicable OpenAI terms and access
rights. This repository does not ship or modify the Codex application.

## Before publishing

1. Confirm ownership and employer/client permission where applicable. Obtain legal
   review or rightsholder permission if source derivation or service use is disputed.
2. Run `npm ci`, `npm test`, `npm run check:release`, and inspect
   `npm pack --dry-run --json`. Keep real configuration, tokens, transcripts,
   deployment state, and the private recovery archive out of the public upload.
3. Review LICENSE, NOTICE, provenance, and dependency notices after any dependency
   or source-origin change. Do not claim "certified compliant" or endorsement.
4. Choose and configure the public repository, maintainer identity, issue/security
   channels, and CI before inviting outside users. No remote publication or npm
   publication is performed by the preparation scripts. `private: true` intentionally
   blocks accidental npm publication.
