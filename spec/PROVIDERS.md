# Provider layer

**Status**: Proposed, 2026-10-10. Nothing here is Decided except what DESIGN.md §9 and §10.4 already mark **[D]**: pi-ai 1.x is the provider layer, a connection is one wire type with one provider and one set of settings, every provider type has an overridable base URL, model lists are fetched from the upstream, and users can add and edit models.

This is phase 0's provider work (PLAN.md): connections, model lists, user-defined models with capabilities, write-only keys, and one streaming entry point that the context assembler (phase 2) and the agent loop (phase 4) will call. It's written as a delta from reference-harness (CLAUDE.md), which runs pi-ai 0.84.2 with a patch. The reference is the `reference-harness` worktree.

---

## 1. Summary of the deltas

| Area | reference-harness (0.84.2) | Here (pi-ai 1.0.x) | Why |
|---|---|---|---|
| Where models come from | Hand-written TOML `[models.*]`; `createModelFromConfig` builds every `Model` | Rows in `connections` and `models`, per user. Fetched from the upstream, merged with pi-ai's built-in catalog, and edited by the user | DESIGN §9 [D]: fetched lists, user edits, separate users |
| Keys | `${ENV}` placeholders in TOML, one shared key; a missing variable silently becomes `""` | Stored per connection, encrypted, write-only. Never read from the server's environment | Multi-user: one user's key must never serve another user. Nothing silent |
| Calling pi-ai | `streamSimple` from `@earendil-works/pi-ai/compat`, which pi-ai calls a temporary entry point | The lazy API implementations (`api/<api>.lazy`) called directly, with an explicit key and `normalizeContext` | `/compat` is deprecated. The `Models` collection resolves keys from the environment and a credential store per provider, which doesn't fit per-user connections (§4) |
| Agent loop in between | Every call goes through pi-agent-core, so errors arrive flattened to strings and reference-harness tags classes inside them | Non-agentic generation calls the provider layer directly. Errors are typed values (§7) | Phase 2 needs no agent loop. Phase 4 decides how pi-agent-core wraps this |
| Retries | Layer 0: buffers a whole attempt and forwards it only on `done`, then retries any failure | Retries only before the first token. A failure after tokens is kept as a failed version and the user decides (§7) | RP streams to a person, so buffering would hide the stream. DESIGN §3.1: failed generations are versions |
| Cache breakpoints | `onPayload` injectors find the boundaries by searching the wire text for `<system>`, `<conversation_summary` and similar (reference-harness's own note says they should come from the context code) | The assembler marks breakpoint positions structurally, and a per-API `onPayload` step translates them (§8) | Fixes the weakness reference-harness flags itself |
| Thinking levels | Hand-mirrors pi-ai internals (`THINKING_BUDGET_BY_LEVEL`, the adaptive heuristic), which have already drifted | `getSupportedThinkingLevels(model)` and `thinkingLevelMap` from pi-ai 1.x | No mirror to drift |
| Cache TTL | Not modelled | `Model.promptCache` from pi-ai's catalog, overridable per model or connection | Feeds the cache-warmth indicator (DESIGN §5.5) |
| The patch | Two hunks: Anthropic `stopCategory`, and the Responses deferred-tool namespace | **No patch** (§10) | `onProviderStreamEvent` exposes `stop_details`. Deferred tools are phase 4 |
| Base URLs | Trusted config written by the operator | Typed by users, so the server makes requests wherever a user points it. That needs a policy (§6) | ST's 2026 SSRF CVEs (DESIGN §11) |

Kept as in reference-harness:
- `maxRetries: 0` on the SDKs, so retries happen in one place and are visible.
- `sessionId` for cache affinity (reference-harness uses the timeline key; here, the chat id).
- `onResponse` for status codes and `Retry-After`.
- `isContextOverflow` and `calculateCost` from pi-ai.
- The SDK-free paths stay out of scope (captioning, embeddings, rerank, decision models). None of them is needed in phase 0.

---

## 2. Connections

A connection is **one provider kind, one wire API, one base URL, one key, and headers** (DESIGN §9 [D]). You switch models within a connection; otherwise you switch connections.

**[P] Provider kinds.** A kind is a preset that fills in everything except the key:

| Kind | pi provider id | Wire API | Default base URL | Model list |
|---|---|---|---|---|
| `anthropic` | `anthropic` | `anthropic-messages` | `https://api.anthropic.com` | `GET /v1/models` |
| `openai` | `openai` | `openai-responses` | `https://api.openai.com/v1` | `GET /models` |
| `openrouter` | `openrouter` | `openai-completions` | `https://openrouter.ai/api/v1` | `GET /models` (has context length, pricing, modalities, supported parameters) |
| `google` | `google` | `google-generative-ai` | `https://generativelanguage.googleapis.com/v1beta` | `models.list` (token limits, thinking) |
| `deepseek`, `xai`, `mistral`, … | pi's id | as in pi's catalog | pi's | `GET /models` |
| `openai-compatible` | `custom` | `openai-completions` (or `openai-responses`) | none, required | `GET /models`; reads vLLM's `max_model_len` and llama.cpp's `meta.n_ctx_train` when present |

- The kind decides the pi `provider` string on every `Model` built from the connection. pi-ai uses that string, together with the base URL, to pick request dialects. reference-harness sets `provider` to the real upstream for the same reason (`schema.ts:842-847`). A custom URL defeats pi's URL-based detection, but the kind still names the dialect, so an OpenRouter-compatible server keeps OpenRouter's routing, reasoning and session headers.
- Every kind's base URL is overridable (DESIGN §9 [D]).
- **[P] Schema change.** Today `connections.api` holds values that mix wire APIs and providers (DATA-MODEL §11 lists `gemini` and `openrouter` next to `openai-completions`). Migration `0005_providers` replaces it with `kind` plus `api`, while the table is still empty. The other changes below go in the same migration.

**Fields** (the existing table, plus):
- `kind`, `api` (above)
- `key_hint`: the last 4 characters of the key, so the user can tell which key is stored. Never more.
- `compat_json`: connection-wide pi `compat` overrides (for example `supportsDeveloperRole: false` for a vLLM server). Model-level overrides win.
- `cache_ttl_s`: an optional connection-wide TTL (DESIGN §5.5)
- `max_concurrent`: an optional cap on parallel requests (§7.3)
- `deleted_at`, `bin_item_id`: connections go through the recycle bin (§9)

**[P] Operations** (`db/ops.ts`; every one scoped to the acting user, as in ARCHITECTURE §3.8):
- `CreateConnection`, `UpdateConnection` (with `expectedRowVersion`)
- `SetConnectionKey`, `ClearConnectionKey`: the only way a key enters, and nothing returns it
- `DeleteConnection`, through the bin
- `ListConnections`, `GetConnection`: the key appears only as `hasKey` and `keyHint`
- `TestConnection`: fetches the model list, or sends one tiny request when the list endpoint doesn't exist, and reports the typed result (§7.1)

---

## 3. Models

### 3.1 Three sources, merged per field

A model's effective description is built from, in increasing precedence:
1. **pi-ai's built-in catalog** (`getBuiltinModel(provider, id)` from `providers/all`, the static, typed catalog). It has context window, max output, input modalities, reasoning, thinking levels, cost, prompt-cache TTLs and compat flags for known models. It's matched on (pi provider id, model id), so it applies through a custom base URL too, as long as the ids match.
2. **The fetched upstream entry.** What the list endpoint reports: OpenRouter's context length, pricing and modalities; vLLM's `max_model_len`; Google's token limits.
3. **The user's edits.** These always win (DATA-MODEL §11).

The upstream beats the catalog because it describes the endpoint actually in use (a local server's real context size, a gateway's real pricing). Fields neither source knows get safe defaults (text only, no reasoning, no prefill, no TTL) and are flagged in the model editor as **unknown, not "no"**, so nothing about a capability is assumed silently.

**[P] Schema change** in `0005_providers`. Split `models.capabilities_json` so a refresh can never overwrite an edit:
- `upstream_json`: catalog plus fetched data, rewritten by every refresh
- `overrides_json`: user edits, written only by the user
- `missing_since`: set when a refresh no longer lists the model

The effective model is computed from the two when a request is built, and in the model picker. It isn't stored.

### 3.2 Capability fields

The user-editable fields (DESIGN §9 [P]), mapped to what pi-ai's `Model` needs:

| Field | pi-ai `Model` | Notes |
|---|---|---|
| `context` | `contextWindow` | |
| `max_output` | `maxTokens` | |
| `vision` | `input: ["text", "image"]` | Drives the "no vision" warning (DESIGN §10.2a) |
| `reasoning`, `thinking_levels` | `reasoning`, `thinkingLevelMap` | |
| `tools` | not on `Model` | The agent loop checks it in phase 4 |
| `prefill` | not on `Model` | `none`, `assistant` (a trailing assistant message), or `tool_schema` (reference-harness's GPT prefill, ported later). Where it's `none`, the assembler drops prefill and the preview says so (DESIGN §1.2) |
| `cache_ttl_s` | `promptCache` | Feeds the cache-warmth indicator |
| `cache_breakpoints` | not on `Model` | `auto` (pi-ai's markers), `explicit` (§8), `none` |
| `cost` | `cost` | So `calculateCost` works for any model |
| `compat` | `compat` | Raw pi compat overrides, an escape hatch. Merged over the connection's |
| `sampling` | `samplingParams` | Per-model defaults. Presets map their samplers per provider later (phase 1) |

### 3.3 Fetching

- **On demand.** A refresh runs when the connection is created, when the key or base URL changes, and when the user presses refresh in the picker. There's no background polling.
- **Off the writer.** The fetch runs on the main thread as plain I/O, under the base-URL policy (§6). Only the resulting upsert goes to the writer, as one transaction (CLAUDE.md).
- **Models are never deleted by a refresh.** Versions and rollouts reference `models(id)` by foreign key, and the picker must still name the model an old message came from. A model that disappears gets `missing_since` and drops out of the picker. It stays selectable from a chat that already uses it, with a warning.
- **User models** (`source = 'user'`) are added by hand under any connection, for endpoints without a list or models the list leaves out.
- **Hidden models** stay hidden across refreshes.

### 3.4 Why not pi-ai's own dynamic providers

pi-ai 1.x has `createProvider({ fetchModels })` and a `ModelsStore`. None of its built-in generic providers fetch `/models`, though, and its store keeps one catalog per provider id. Here, each user can have several connections of the same kind with different base URLs (DESIGN §9 [P]). Fetching is about 30 lines per list format, so we own it.

---

## 4. Calling pi-ai

**[P]** The `Providers` service (an Effect service, EFFECT.md §3) exposes one operation:

```ts
stream(request: {
  user: UserId
  connection: ConnectionId
  model: ModelId
  context: Context                          // pi-ai's, built by the assembler
  options: { reasoning?, maxTokens?, temperature?, sampling?, sessionId?, cacheRetention?, breakpoints? }
}): Stream<ProviderEvent, ProviderError>
```

Steps:
1. **Resolve.** Read the connection and model rows (reader worker), check that both belong to `user`, decrypt the key, and build a `Model<Api>` from the merged description (§3.1). `baseUrl` is the connection's, and `provider` is the kind's pi id.
2. **Call** the API's lazy implementation directly. For example `openAICompletionsApi().streamSimple(model, normalizeContext(context), opts)`, with:
   - `apiKey` set explicitly. pi-ai's direct API calls throw without one, so they never fall back to environment keys. A keyless local server gets a placeholder key.
   - `env: {}`
   - `maxRetries: 0`
   - `signal` from the fiber (EFFECT.md §5: interruption aborts the request)
   - `fetch`: the guarded fetch (§6)
   - `onResponse`: records the status and `Retry-After`
   - `onPayload`: applies breakpoints (§8) and captures the final payload for the request inspector, with auth headers never included
   - `onProviderStreamEvent`, where needed: provider fields pi doesn't normalize, such as Anthropic's refusal `stop_details.category`
3. **Bridge** the event stream with `Stream.fromAsyncIterable`. On termination, map the final `AssistantMessage` to a typed result or `ProviderError` (§7).

**Why not the `Models` collection.** `createModels()` routes requests by provider id and resolves auth through each provider: a stored credential per provider id, then environment variables such as `ANTHROPIC_API_KEY`.
- A server holding several users' connections would need a collection per connection, and would have to make sure no provider ever reached `process.env`.
- Direct API calls are documented public API ("Calling API Implementations Directly" in pi-ai's README). They take the model as plain data and the key as a parameter. That's exactly our shape.
- What we give up: `models.refresh()` and OAuth logins. OAuth subscriptions (Copilot, Codex) aren't in scope.

**Lazy SDK loading.** Each API implementation loads its SDK on first use, so a server whose users only use OpenRouter never loads the Anthropic or Google SDKs. Server memory is budgeted (ARCHITECTURE §3.6), so this matters.

**The main thread.** Provider streams are network I/O plus SSE and JSON parsing, which stays on the main thread. Their cost counts against the event-loop delay budget (ARCHITECTURE §2) and must be measured with several concurrent generations (DESIGN §10.1).

---

## 5. Keys

- **[P] Encrypted at rest.** Keys are encrypted with AES-256-GCM using a server secret, with a fresh nonce per key and the connection id as additional authenticated data, so a ciphertext can't be moved to another connection.
- **[P] The secret.** It comes from `SECRET_KEY` (an env var or a Docker secret file). If that's unset, the server generates one at first start in `DATA_DIR/secret.key`, mode 0600. Honest scope: with the key file next to the database, encryption protects against a leaked database or backup on its own, not against someone holding the whole data directory. Setting `SECRET_KEY` separately closes that gap.
- **Write-only** (DESIGN §9, §11). No RPC returns a key. Reads return `hasKey` and `keyHint`.
- **Decrypted only for a request**, on the main thread, and never logged. Provider error text is shown to the user, so error bodies are scrubbed of the key before they're stored or sent.
- **Rotating `SECRET_KEY`**: a `rekey` command, later. Until then, a lost secret means re-entering the keys. The connections themselves survive.

---

## 6. Base URLs and SSRF

Users type base URLs, and the server fetches from them and shows the user the response or error text. In a multi-user instance, that lets any user probe the server's own network: `localhost`, the Docker network, `169.254.169.254`. ST's 2026 CVEs were in exactly this kind of proxy (DESIGN §11).

**[P] Policy:**
- **`AUTH_MODE=single`:** no restriction. The user owns the machine, and a local llama.cpp on `127.0.0.1` must just work.
- **Multi-user:** admins may use any address. For everyone else, loopback, private, link-local and unique-local addresses are refused, unless the admin lists the host in an instance setting (`provider.allowed_hosts`). A local server on their own network is one entry there.
- **Checked at connect time, not at save time.** The guarded `fetch` passed to pi-ai resolves DNS and checks the actual IP. That defeats DNS rebinding, a public name that later resolves to a private address. Redirects are followed manually, each hop checked, at most 3.
- **Coverage gap to verify:** pi-ai documents that adapters "that cannot inject a custom implementation may reject" a custom `fetch`. The Google SDK path needs testing. If it bypasses `fetch`, restricted users get only the default Google base URL.

---

## 7. Errors, retries, concurrency

### 7.1 Typed errors

`ProviderError` is a tagged union. It's classified from the final `AssistantMessage` (`stopReason`, `rawStopReason`, `errorMessage`), the status captured by `onResponse`, and pi-ai's `isContextOverflow` and `isRetryableAssistantError`:
- `Auth` (401/403)
- `RateLimited { retryAfterMs? }` (429, 503 with `Retry-After`)
- `Overloaded`
- `ContextOverflow`
- `Refused { category? }`
- `BadRequest { message }`
- `Network`
- `Aborted`
- `Unknown { message }`

This replaces reference-harness's error-string tags, which only exist because pi-agent-core keeps nothing but `errorMessage`. The non-agentic path doesn't go through pi-agent-core, and phase 4 can carry the typed error alongside the loop.

**To verify:** reference-harness notes that the Anthropic SDK threw before `onResponse` fired, so Anthropic 429s had no `Retry-After` (`scheduler.ts:1205-1212`). pi-ai 1.0.3 calls `onResponse` explicitly in its Anthropic adapter. A test against a mock 429 settles it.

### 7.2 Retries

- **Before the first token:** `RateLimited`, `Overloaded` and `Network` retry automatically, with backoff that honors `Retry-After`, up to a budget. Each retry shows on the generating version ("retrying, 2/3").
- **After tokens:** nothing retries automatically. The version ends `failed` with its partial text and the error (DESIGN §3.1: failed generations are versions), and the user decides: swipe again, continue, or keep the partial.
- **This is the main delta from reference-harness's Layer 0,** which buffers everything until `done`. An agent can afford to buffer; a person watching a stream can't.
- Retry and backoff use Effect `Schedule` inside the generation's fiber, so stopping the version interrupts the wait too.

### 7.3 Concurrency

Any number of generations run at once (DESIGN §10.1). Two limits apply:
- `max_concurrent` per connection, optional, queueing in arrival order
- a `RateLimited` with `Retry-After` pauses new requests on that connection until the time passes, as reference-harness's group backoff does

reference-harness's full scheduler (priority classes, admission inside retry, health probes, fallback chains) isn't ported in phase 0. The `request_class` column already exists on `rollouts` for when idle-time jobs arrive (phase 3). The cold-cache stagger (DESIGN §5.5) is phase 2.

---

## 8. Cache breakpoints

- **`auto`:** pi-ai's own markers. Anthropic gets `cache_control` on the system prompt, the last tool and the last message. OpenAI gets `prompt_cache_key` from `sessionId`, and OpenRouter gets `x-session-id`. `cacheRetention` picks short or long TTLs where the provider has them.
- **`explicit`:** reference-harness's scheme (DESIGN §5.5 [P]): system/preset, summary layer, last stable timeline item.
  - The difference is where positions come from. The **assembler** returns them as message indices into the `Context` it built, and a per-API `onPayload` step maps each index to the wire item pi-ai produced for it.
  - pi-ai's conversion is deterministic per API, so each mapping is covered by a test on synthetic contexts, including the cases where pi merges or splits messages (system folding, tool results).
  - This replaces reference-harness's wire-text search.
  - The phase 0 interface accepts `breakpoints` and applies them for `anthropic-messages`. The other APIs and the rest of the scheme come with the assembler (phase 2).
- **Observed caching** comes from `usage.cacheRead` and `usage.cacheWrite` on every response. It's stored per version and rollout (`cache_observed_json` already exists), and it's what turns the cache indicator from "warm (assumed)" into "warm (verified)" (DESIGN §5.5).

---

## 9. Deleting connections and models

Versions and rollouts reference `connections(id)` and `models(id)` by foreign key, which is how a message records what generated it (DATA-MODEL §4.5, §7.1).
- **Deleting** a connection goes to the recycle bin, like chats and entities (ARCHITECTURE §3.11). It stops appearing in pickers. Chats bound to it show a "connection deleted" warning at the composer instead of silently switching.
- **Purging** wipes the key, URL and headers, and keeps the row and its models as a tombstone, so old messages still name their model. This is the same pattern as a purged entity keeping its row.

---

## 10. pi-ai version and the patch

- **Pin `@earendil-works/pi-ai` 1.0.3,** the latest release older than the 5-day cooldown. Its dependencies (the Anthropic, OpenAI, Google and Bedrock SDKs, typebox) are pinned transitively by the lockfile.
- **No patch:**
  - `stopCategory` (reference-harness 7da8400): pi-ai still doesn't normalize it, but the public `onProviderStreamEvent` hook sees Anthropic's `message_delta.stop_details`. Refusal handling isn't phase 0 work anyway.
  - The Responses deferred-tool namespace (reference-harness 347a99b): 1.0.3 still replays a namespace only for the same model (`openai-responses-shared.js:227`). It only matters for tool search over deferred tools on Responses-compatible endpoints. Re-check in phase 4.
- **A guard test per pi-ai behavior we rely on** that isn't strongly documented: placeholder keys for keyless servers, the `onPayload` replacement contract, the breakpoint index mapping. That's reference-harness's `pi-ai-deferred-namespace.test.ts` pattern. A pi-ai bump that breaks one fails `npm run check`.

---

## 11. Testing

- **Unit:** pi-ai's faux provider (`providers/faux`) for the service's stream, error mapping and retry logic.
- **HTTP:** a local mock endpoint for each list format and each error class (401, 429 with `Retry-After`, overflow text, mid-stream disconnect). This is the start of the recording endpoint the differential harness needs (PLAN phase 1).
- **SSRF guard:** private and loopback targets, DNS rebinding through a resolver stub, redirect chains.
- **No real keys in CI.** A manual script runs one request per configured connection.

---

## 12. Phase 0 scope

Built:
- Migration `0005_providers`: §2 and §3.1.
- The secret and encryption: §5.
- Connection and model operations, model fetching for the formats in §2, and `TestConnection`.
- The `Providers.stream` service, with typed errors, retries before the first token, the per-connection cap, the guarded fetch, and `anthropic-messages` explicit breakpoints.
- A minimal settings page in the client: connections and their models, adding a key, testing, editing a model's capabilities.

Not built until the assembler needs it: sampler mapping from presets, prefill, the other APIs' explicit breakpoints, the cold-cache stagger, and per-chat model bindings in the UI (the `model.binding` state event already exists, DATA-MODEL §5.3).

---

## 13. Open questions for the owner

1. **Base-URL policy (§6):** is "admins anything, everyone else public addresses plus an admin allowlist" right? Or should multi-user instances simply trust all their users?
2. **The model list (§3.3):** if a custom server can't list models, should a connection be able to name a separate URL for its model list?
3. **The secret (§5):** is a generated `DATA_DIR/secret.key` an acceptable default, or should the server refuse to start without `SECRET_KEY`?
4. **Provider kinds (§2):** is the first set (Anthropic, OpenAI, OpenRouter, Google, OpenAI-compatible, and pi's other API-key providers through the same table) what you need on day one?
