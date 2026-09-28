// Secret redaction for text that leaves the user's own view and enters an AGENT's context.
//
// Why: transcripts are full of credentials — pasted tokens, `export KEY=…`, auth headers echoed in
// tool output. The dashboard is the user reading their own history, so it shows everything. The MCP
// server is different: a hit lands in a live agent's context, where it can be echoed, written to a
// file, committed, or forwarded to another tool. So every string the MCP server emits passes here.
//
// Precision over recall: each pattern is anchored on a vendor prefix or an explicit assignment, so
// session ids, UUIDs and git SHAs — which agents need to follow receipts — are never touched.
// The replacement names the kind, so the agent can tell the user a secret existed without seeing it.

const PATTERNS = [
  // PEM blocks first: they contain text the later rules could partially match
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['openvsx-token', /\bovsxat_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['stripe-key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
];

// `Authorization: Bearer <tok>` and `API_KEY=<value>` — keep the label so context survives, drop the value.
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g;
// The keyword must END the label (`\b`): NPM_TOKEN / client_secret / GITHUB_PAT match, but filePath,
// max_tokens, token_count, author, secretary do not — a looser rule would blank every path in tool output.
const ASSIGNMENT = /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|_pat)\b["']?\s*[:=]\s*["']?)([^\s"'`,;)}\]]{12,})/gi;

export function redact(text) {
  if (typeof text !== 'string' || text.length < 12) return text;
  let s = text;
  for (const [kind, re] of PATTERNS) s = s.replace(re, `[redacted:${kind}]`);
  s = s.replace(BEARER, '$1[redacted:bearer-token]');
  // skip values an earlier rule already replaced, so labels don't nest
  s = s.replace(ASSIGNMENT, (m, label, value) => (value.startsWith('[redacted') ? m : `${label}[redacted:secret]`));
  return s;
}

/** Redact every string inside a JSON-able value — the final net over a whole tool result. */
export function redactDeep(v) {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = redactDeep(val);
    return out;
  }
  return v;
}
