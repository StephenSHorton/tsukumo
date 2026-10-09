# MCP `2026-07-28` migration checklist (Tsukumo)

Spec: [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) · Changelog: [key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) · Announcement: [blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/)

**Goal:** keep spawn-on-demand stdio as the primary model; upgrade the SDK when Grok (and other clients) speak the new core; optionally add MRTR confirmation on `send_message`.

This is **not** a rewrite. Protocol sessions go away; **process lifetime** (Discord login + live buffer) stays.

---

## When to start

| Trigger | Action |
|---------|--------|
| Grok Build / Codex advertise `2026-07-28` support (or dual-stack) | Run Phase A–C |
| TypeScript SDK ships stable `2026-07-28` APIs | Bump dependency |
| Clients still only speak `2025-11-25` | **Wait** — stay on current SDK |

Do **not** force-upgrade solely because the final spec date is `2026-07-28`. Coordinate with the **client** that spawns you.

---

## Current baseline (pre-migration)

| Item | Today |
|------|--------|
| Entry | `src/mcp.ts` → `StdioServerTransport` + `McpServer` |
| SDK | `@modelcontextprotocol/sdk` `^1.12.1` |
| Transport | stdio only (optional non-MCP HTTP in `serve.ts`) |
| “Session” | Process-scoped: `sessionPromise` + Discord client + live buffer |
| Tools | `tsukumo_status`, `list_guilds`, `list_channels`, `get_messages`, `get_recent`, `get_message`, `send_message` |
| Not used | Roots, Sampling, Logging, elicitation APIs, protocol `Mcp-Session-Id`, Streamable HTTP |

---

## Phase A — Package & types

- [ ] Read TS SDK migration notes for `2026-07-28` / v2 (official [typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)).
- [ ] Bump `@modelcontextprotocol/sdk` to the version that targets `2026-07-28`.
- [ ] `bun install` and fix import path / API renames (`McpServer`, tool registration, result types).
- [ ] `bun run typecheck` clean.
- [ ] Confirm `server/discover` is handled by the SDK (or implement if the high-level API no longer auto-wires it). Servers **MUST** implement `server/discover` under the new core.

**Note:** Handshake (`initialize` / `initialized`) is removed at the protocol layer. SDK may still expose a familiar connect API; do not re-add a manual initialize dance.

---

## Phase B — API surface & semantics

### Keep (app state, not protocol session)

- [ ] Lazy Discord login on first tool call (`getSession()` / `sessionPromise`).
- [ ] Cleanup on stdin close / process exit (`destroy()`).
- [ ] Live message buffer for **this process only**.

### Rename / reword (docs + tool descriptions)

| Old language | New language |
|--------------|--------------|
| “MCP session” | “this process” / “process lifetime” |
| “since this MCP session logged in” | “since this process logged into Discord” |
| “so initialize is snappy” | “so first tool call is snappy” / “lazy login” |

Checklist of strings:

- [ ] `src/mcp.ts` file header comment
- [ ] `get_recent` tool description
- [ ] `src/config.ts` comments if they say “MCP session”
- [ ] `README.md` architecture section
- [ ] Any log lines that say “session” meaning protocol session

### Protocol features you still skip

- [ ] **Do not** add Roots, Sampling, or Logging (deprecated).
- [ ] **Do not** implement Streamable HTTP + `Mcp-Method` / `Mcp-Name` unless product needs remote multi-client hosting.
- [ ] **Do not** treat `serve.ts` as MCP — leave it as private loopback REST unless you deliberately design remote MCP later.

### List caching (optional, low priority)

If the SDK exposes result metadata for `tools/list`:

- [ ] Prefer deterministic tool order (already fixed registration order is fine).
- [ ] Set `ttlMs` / `cacheScope` if the high-level API makes it easy; otherwise skip.

---

## Phase C — Smoke test (required before merging)

With Grok (or another client) on the new protocol:

```text
tsukumo_status
  → list_guilds
  → list_channels (guild_id)
  → get_messages (channel_id, small limit)
  → get_recent (optional)
  → send_message (test channel, benign content; optional files: absolute local paths)
```

- [ ] Cold start: first tool pays Discord login; subsequent tools reuse connection.
- [ ] Process exit when client tears down the server.
- [ ] No stdout pollution (protocol only; logs on stderr).
- [ ] `bun run typecheck` + manual client path green.

Grok config (unchanged shape):

```toml
[mcp_servers.tsukumo]
command = "bun"
args = ["run", "/Users/you/projects/tsukumo/src/mcp.ts"]
enabled = true
```

---

## Phase D — MRTR sketch for `send_message` (optional product)

[Multi Round-Trip Requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr) replace server-initiated elicitation. Server returns `resultType: "input_required"`; client retries the **same** method with `inputResponses`.

### When to use it

- Missing / ambiguous `channel_id`
- Empty or oversize `content`
- Explicit confirm before post (especially if you later add broadcast / multi-channel tools)

### Sketch (illustrative — adjust to final SDK types)

```ts
// Conceptual; wire to whatever the 2026-07-28 TS SDK exposes for InputRequiredResult.

type InputRequest = {
  // id client echoes back in inputResponses
  id: string;
  // e.g. elicitation-style schema or structured form the client understands
  // Exact shape is defined by the MRTR / input request types in the SDK.
  [key: string]: unknown;
};

function needsConfirm(params: {
  channel_id: string;
  content: string;
  confirm?: boolean;
}): InputRequest[] | null {
  if (params.confirm === true) return null;
  if (!params.channel_id?.trim()) {
    return [
      {
        id: "channel_id",
        // Ask client/user for channel_id
      },
    ];
  }
  // Optional: always confirm non-trivial posts
  if (params.content.length > 0) {
    return [
      {
        id: "confirm_send",
        // "Post this message to channel X?"
      },
    ];
  }
  return null;
}

// Pseudo-handler:
// 1. If inputResponses already contain confirm_send / channel_id → proceed.
// 2. Else if needsConfirm(...) → return { resultType: "input_required", inputRequests, requestState? }.
// 3. Else post via Discord and return { resultType: "complete", content: [...] }.
```

### Implementation checklist

- [ ] Confirm client (Grok) supports MRTR retries end-to-end.
- [ ] Add optional `confirm` boolean (or rely purely on MRTR) so agents can skip double-prompt when intentional.
- [ ] Put correlation data in `requestState` if needed across retries (do not invent protocol session IDs).
- [ ] Keep non-MRTR path working for older clients if dual-stack is required.
- [ ] Document in README: “destructive / public posts may ask for confirmation.”

### What not to do

- Do not hold an open bidirectional stream waiting for the user.
- Do not reintroduce `elicitation/create` server→client requests.
- Do not block forever inside the tool handler waiting on Discord UI.

---

## Phase E — Tasks extension (later, only if needed)

Only if long Discord digs hit `tool_timeout_sec` or you want background “summarize channel history” jobs:

- [ ] Adopt official extension `io.modelcontextprotocol/tasks` (not experimental core).
- [ ] Prefer poll `tasks/get` + `tasks/update` over blocking a single call.
- [ ] Keep default tools synchronous for simple list/send.

Skip until a real timeout pain shows up.

---

## Version bump suggestion

| Change | Version |
|--------|---------|
| SDK + renames only | `0.3.x` or `0.4.0` |
| MRTR on `send_message` | `0.4.0` / `0.5.0` (user-visible behavior) |
| Tasks extension | minor after MRTR |

---

## Out of scope

- Moving off stdio to hosted Streamable HTTP
- Enterprise Managed Authorization / CIMD (client-side OAuth story)
- Implementing Roots / Sampling “because the old docs mentioned them”

---

## Related

- Repo: spawn-on-demand design in `README.md`
- Spec SEP index via changelog links above
