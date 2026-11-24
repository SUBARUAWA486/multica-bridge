// SPDX-License-Identifier: MIT
// Token-format rules adapted from Gitleaks (MIT), copyright 2019 Zachary Rice.
// Source commit and adaptation scope: docs/provenance.md; license: licenses/GITLEAKS.txt.
// This is a small redaction subset, not a port of the Gitleaks detection engine.
const rules = [
  // Gitleaks github-pat / fine-grained-pat / gitlab-pat: accept shortened examples too.
  [/\b(?:gh[pousr]_[\w]{20,255}|github_pat_[\w]{20,255}|glpat-[\w-]{20,255})\b/g, '[REDACTED_TOKEN]'],
  // aws-access-token: retain the commonly used access/session-key prefixes.
  [/\b(?:AKIA|ASIA|A3T[A-Z0-9]|ABIA|ACCA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]'],
  // openai-api-key / anthropic-api-key: broader prefix matching for legacy variants.
  [/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_TOKEN]'],
  // slack-app-token / bot-token / user-token: broader prefix family for redaction.
  [/\b(?:xapp-|xox[bporase]-)[A-Za-z0-9-]{10,}\b/g, '[REDACTED_TOKEN]'],
  // stripe-access-token and gcp-api-key.
  [/\b(?:sk|rk)_(?:live|test|prod)_[a-zA-Z0-9]{10,99}\b/g, '[REDACTED_TOKEN]'],
  [/\bAIza[\w-]{35}(?![\w-])/g, '[REDACTED_TOKEN]'],
  // jwt: deliberately broader segments, without entropy/delimiter checks.
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  // private-key: also suppress incomplete PEM blocks in partial tool output.
  [/-----BEGIN [A-Z0-9_ -]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9_ -]{0,100}PRIVATE KEY(?: BLOCK)?-----|$)/g, '[REDACTED_PRIVATE_KEY]'],
];

export function redactTokenFormats(text) {
  for (const [pattern, replacement] of rules) text = text.replace(pattern, replacement);
  // Multica authentication token prefixes are protocol-format identifiers only.
  return text.replace(/\b(?:mul_|mat_|mdt_)[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_TOKEN]');
}
