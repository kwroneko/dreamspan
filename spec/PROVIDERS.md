# Provider layer

**Status**: Proposed, 2026-10-10, with the owner's decisions of the same day marked **[D]**. **Partially implemented:** the schema (§2, §3.1, §9.1, migration `0005_providers`) is built and documented in ARCHITECTURE.md §3.12. One change from §2: header values are encrypted like the key, with only header names in the clear. Also Decided, in DESIGN.md §9 and §10.4:
- pi-ai 1.x is the provider layer
- a connection is one wire type, one provider and one set of settings
- every provider type has an overridable base URL
- model lists are fetched from the upstream, and users can add and edit models

This is phase 0's provider work (PLAN.md): connections, model lists, user-defined models with capabilities, write-only keys, the usage ledger, and one streaming entry point that the context assembler (phase 2) and the agent loop (phase 4) will call. It's written as a delta from reference-harness (CLAUDE.md), which runs pi-ai 0.84.2 with a patch. The reference is the `reference-harness` worktree.

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
| Usage and cost | `budget.record` ledger rows on commit; pi-ai's `calculateCost` against config prices | A ledger row for every request, retries and failures included, with raw provider usage kept. Cost comes from formulas the user can override (§9) | Owner [D]: tracking every run is the part that matters now |
| Outbound network | Direct, or the process's proxy environment | One instance-wide HTTP or SOCKS proxy for every outgoing request, a bypass list with local ranges by default, and a per-connection override (§6) | Owner [D] |
| The patch | Two hunks: Anthropic `stopCategory`, and the Responses deferred-tool namespace | **No patch** (§11) | `onProviderStreamEvent` exposes `stop_details`. Deferred tools are phase 4 |

Kept as in reference-harness:
- `maxRetries: 0` on the SDKs, so retries happen in one place and are visible.
- `sessionId` for cache affinity (reference-harness uses the timeline key; here, the chat id).
- `onResponse` for status codes and `Retry-After`.
- `isContextOverflow` from pi-ai.
- Usage left unknown is `NULL`, never zero.
- The SDK-free paths stay out of scope (captioning, embeddings, rerank, decision models). None of them is needed in phase 0.

---

## 2. Connections

A connection is **one provider kind, one wire API, one base URL, one key, and headers** (DESIGN §9 [D]). You switch models within a connection; otherwise you switch connections.

**Provider kinds.** A kind is a preset that fills in everything except the key. It names an upstream API as that upstream defines it, endpoints included. Changing the base URL moves the whole API; there are no per-endpoint URLs (owner [D]). The order below is the order in the "new connection" picker (owner [D]):

| Kind | pi provider id | Wire API | Default base URL | Model list |
|---|---|---|---|---|
| **OpenAI Chat Completions** (default) | `openai` | `openai-completions` | `https://api.openai.com/v1` | `GET /models`; also reads vLLM's `max_model_len` and llama.cpp's `meta.n_ctx_train` |
| **Anthropic** | `anthropic` | `anthropic-messages` | `https://api.anthropic.com` | `GET /v1/models` |
| **OpenAI Responses** | `openai` | `openai-responses` | `https://api.openai.com/v1` | `GET /models` |
| **OpenRouter** | `openrouter` | `openai-completions` | `https://openrouter.ai/api/v1` | `GET /models` (context length, pricing, modalities, supported parameters) |
| **DeepSeek** | `deepseek` | `openai-completions` | `https://api.deepseek.com` | `GET /models` |
| **Google** | `google` | `google-generative-ai` | `https://generativelanguage.googleapis.com/v1beta` | `models.list` (token limits, thinking) |
| pi's other API-key providers (xAI, Mistral, …) | pi's id | as in pi's catalog | pi's | `GET /models` |

- **OpenAI Chat Completions doubles as the generic OpenAI-compatible kind**: point its base URL at llama.cpp, vLLM or any gateway. Both OpenAI kinds are required on day one (owner [D]).
- **DeepSeek is its own kind** (owner [D], at minimum). It has reasoning quirks in agentic use: the API requires `reasoning_content` on replayed assistant messages in tool-call turns, and it has its own thinking switch. pi-ai covers both through compat (`requiresReasoningContentOnAssistantMessages`, `thinkingFormat: "deepseek"`), auto-detected for the `deepseek` provider. A guard test pins that behavior (§11).
- **The kind decides the pi `provider` string** on every `Model` built from the connection. pi-ai uses that string, together with the base URL, to pick request dialects. reference-harness sets `provider` to the real upstream for the same reason (`schema.ts:842-847`). The kind still names the dialect behind a custom gateway URL, so a gateway in front of OpenRouter keeps OpenRouter's routing, reasoning and session headers.
- **[P] Schema change.** Today `connections.api` holds values that mix wire APIs and providers (DATA-MODEL §11 lists `gemini` and `openrouter` next to `openai-completions`). Migration `0005_providers` replaces it with `kind` plus `api`, while the table is still empty. The other changes below go in the same migration.
- **Later, separately:** built-in model lists as a fallback for providers whose list endpoint is missing or thin. pi-ai's catalog already contains them.

**Fields** (the existing table, plus):
- `kind`, `api` (above)
- `key_hint`: the last 4 characters of the key, so the user can tell which key is stored. Never more.
- `compat_json`: connection-wide pi `compat` overrides (for example `supportsDeveloperRole: false` for a vLLM server). Model-level overrides win.
- `cache_ttl_s`: an optional connection-wide TTL (DESIGN §5.5)
- `max_concurrent`: an optional cap on parallel requests (§7.3)
- `proxy_mode` (`inherit` · `direct` · `custom`) and `proxy_url_enc`: the per-connection proxy override (§6.2)
- `deleted_at`, `bin_item_id`: connections go through the recycle bin (§10)

**[P] Operations** (`db/ops.ts`; every one scoped to the acting user, as in ARCHITECTURE §3.8):
- `CreateConnection`, `UpdateConnection` (with `expectedRowVersion`)
- `SetConnectionKey`, `ClearConnectionKey`: the only way a key enters, and nothing returns it
- `DeleteConnection`, through the bin
- `ListConnections`, `GetConnection`: the key appears only as `hasKey` and `keyHint`
- `TestConnection`: fetches the model list, or sends one tiny request when the list endpoint doesn't exist. It reports the typed result (§7.1) and the route the request took (§6.2).

**Shared connections (owner [D], later; not designed now).** An admin can provide connections to every user or to chosen users. Connections stay per user by default. Rules:
- users of a shared connection never see or change its sensitive parts (URL, key, proxy)
- the admin can optionally restrict its model list, but users can normally switch models
- optional per-user cost limits, which build on the ledger (§9)

It's a deliberately small, niche feature, not multi-tenancy. The only part that matters now is the ledger recording which user and which connection every request belongs to (§9).

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
| `compat` | `compat` | Raw pi compat overrides, an escape hatch. Merged over the connection's |
| `sampling` | `samplingParams` | Per-model defaults. Presets map their samplers per provider later (phase 1) |

Prices are not a model field. They're cost formulas (§9.3).

### 3.3 Fetching

- **On demand.** A refresh runs when the connection is created, when the key or base URL changes, and when the user presses refresh in the picker. There's no background polling.
- **Off the writer.** The fetch runs on the main thread as plain I/O, through the network layer (§6). Only the resulting upsert goes to the writer, as one transaction (CLAUDE.md).
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
  attribution: { chat?, rollout?, version?, purpose }   // for the ledger (§9)
}): Stream<ProviderEvent, ProviderError>
```

Steps:
1. **Resolve.** Read the connection and model rows (reader worker), check that both belong to `user`, decrypt the key, and build a `Model<Api>` from the merged description (§3.1). `baseUrl` is the connection's, and `provider` is the kind's pi id.
2. **Open a ledger row** (§9.1).
3. **Call** the API's lazy implementation directly. For example `openAICompletionsApi().streamSimple(model, normalizeContext(context), opts)`, with:
   - `apiKey` set explicitly. pi-ai's direct API calls throw without one, so they never fall back to environment keys. A keyless local server gets a placeholder key.
   - `env: {}`
   - `maxRetries: 0`
   - `signal` from the fiber (EFFECT.md §5: interruption aborts the request)
   - `fetch`: the network layer's fetch for this connection (§6)
   - `onResponse`: records the status and `Retry-After`
   - `onPayload`: applies breakpoints (§8) and captures the final payload for the request inspector, with auth headers never included
   - `onProviderStreamEvent`: captures the provider's raw usage object and any routing metadata for the ledger (§9.2), plus fields pi doesn't normalize, such as Anthropic's refusal `stop_details.category`
4. **Bridge** the event stream with `Stream.fromAsyncIterable`. On termination, map the final `AssistantMessage` to a typed result or `ProviderError` (§7), and **close the ledger row**.

**Why not the `Models` collection.** `createModels()` routes requests by provider id and resolves auth through each provider: a stored credential per provider id, then environment variables such as `ANTHROPIC_API_KEY`.
- A server holding several users' connections would need a collection per connection, and would have to make sure no provider ever reached `process.env`.
- Direct API calls are documented public API ("Calling API Implementations Directly" in pi-ai's README). They take the model as plain data and the key as a parameter. That's exactly our shape.
- What we give up: `models.refresh()` and OAuth logins. OAuth subscriptions (Copilot, Codex) aren't in scope.

**Lazy SDK loading.** Each API implementation loads its SDK on first use, so a server whose users only use OpenRouter never loads the Anthropic or Google SDKs. Server memory is budgeted (ARCHITECTURE §3.6), so this matters.

**The main thread.** Provider streams are network I/O plus SSE and JSON parsing, which stays on the main thread. Their cost counts against the event-loop delay budget (ARCHITECTURE §2) and must be measured with several concurrent generations (DESIGN §10.1).

---

## 5. Keys

- **[P] Encrypted at rest.** Keys and proxy URLs (which can contain credentials) are encrypted with AES-256-GCM using a server secret, with a fresh nonce per value and the connection id as additional authenticated data, so a ciphertext can't be moved to another connection.
- **The secret is automatic (owner [D]: setup must be trivial).** The server generates one at first start in `DATA_DIR/secret.key`, mode 0600. `SECRET_KEY` (an env var or a Docker secret file) is optional and overrides it.
  - Honest scope: with the key file next to the database, encryption protects against a leaked database or backup on its own, not against someone holding the whole data directory. Keeping `SECRET_KEY` elsewhere closes that gap for those who want it.
- **Write-only** (DESIGN §9, §11). No RPC returns a key. Reads return `hasKey` and `keyHint`.
- **Decrypted only for a request**, on the main thread, and never logged. Provider error text is shown to the user, so error bodies are scrubbed of the key before they're stored or sent.
- **Rotating `SECRET_KEY`**: a `rekey` command, later. Until then, a lost secret means re-entering the keys. The connections themselves survive.

---

## 6. Network

### 6.1 The priorities (owner [D])

1. **Users are never assumed trusted.** Above everything in this section, one user must never be able to see another user's chats, cards, connections or keys. That has to be certain (DESIGN §11).
2. **The instance must be hard to expose by accident.** Without a password, an IP allowlist or an auth proxy, the server must not listen on anything but localhost. ST is careful here, and so are we. The exact rules are **[O]**: ST's may be stricter than needed, but accidental exposure must stay hard.
3. **Local addresses are legitimate.** Local models on `127.0.0.1` or the LAN are normal, so connections to private addresses are **not blocked by default**. With several users that's a footgun, but not one that justifies breaking the normal case. An operator who wants isolation does it at the routing level: the container's outgoing traffic goes through a VPN or firewall, with exceptions for the local servers it needs.

### 6.2 Outbound proxy

- **[D] One instance-wide proxy**, HTTP or SOCKS, used by **every** outgoing request from the harness: LLM calls, model lists, and anything added later (tools, fetches).
- **[D] A bypass list** of IP ranges and hostnames that go direct. Loopback, private, link-local and unique-local ranges are on it by default, so local servers aren't sent through the proxy.
- **[D] A per-connection override** (`inherit`, `direct`, or a custom proxy). It's an advanced option, hidden in a collapsed section.

**[P] How it's built:**
- **All outgoing HTTP goes through one network module.** It returns a `fetch` per route, and pi-ai receives it as `options.fetch`. A lint rule forbids the global `fetch` and `node:http(s)` everywhere else in the server, so nothing can bypass the proxy by accident.
- **The route is chosen per request:**
  - an explicit per-connection override wins
  - otherwise, a target in the bypass list (by hostname, or by resolved IP) goes direct
  - otherwise, the instance proxy is used
  - with no proxy configured, everything goes direct
- **pi-ai's own proxy support isn't used.** It reads `HTTP_PROXY`/`NO_PROXY` from the environment, matches hostnames only, and rejects SOCKS.
- **To verify before relying on it:**
  - **SDK coverage.** pi-ai warns that adapters "that cannot inject a custom implementation may reject" a custom `fetch`. Each API we ship (completions, responses, anthropic, google) needs a test that its traffic actually goes through our `fetch`. An API that can't must refuse to run when a proxy applies, rather than silently going direct.
  - **The environment.** Make sure a stray `HTTP_PROXY` in the server's environment can't make pi-ai or an SDK route around our `fetch`.
  - **SOCKS.** The undici version to use and its SOCKS5 support; otherwise a `socks` connector under an undici `Agent`.

**[P] UX: showing the route.** The owner was unsure how proxy, bypass and override should present. The proposal follows "nothing changes silently":
- the instance settings hold the proxy and the bypass list
- `TestConnection` and the request inspector state the route each request took ("direct: 192.168.1.20 is in the bypass list", "via proxy socks5://…", "direct: overridden on this connection")
- a connection whose override differs from the instance default shows a small badge in the connection list, even while the advanced section is collapsed

So nobody has to work out from the settings where traffic goes; they're told.

### 6.3 What this replaces

The earlier proposal refused private addresses for non-admin users. It's withdrawn: it breaks local models by default, and the owner's priority is data isolation, not network policy. **[O]** Whether an admin can force the instance proxy on everyone (no per-connection `direct` for non-admins) is left for the shared-connections work.

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

- **Before the first token:** `RateLimited`, `Overloaded` and `Network` retry automatically, with backoff that honors `Retry-After`, up to a budget. Each retry shows on the generating version ("retrying, 2/3") and gets its own ledger row.
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
- **Observed caching** comes from the ledger's cache-read and cache-write counts (§9). It's what turns the cache indicator from "warm (assumed)" into "warm (verified)" (DESIGN §5.5).

---

## 9. Usage and cost

**[D] (owner):** every generation run is tracked, with its uncached input, cache reads, cache writes and output, accounting for each provider's quirks. That's the part that matters now. Cost calculation builds on it, through formulas that ship built in for every provider we support and that users can override.

### 9.1 The ledger: one row per request

**[P]** New table `llm_requests` in `0005_providers`. A row is one HTTP request to a model:
- retries and failed attempts are separate rows, because they can be billed
- so are model-list fetches that cost nothing (none do today) and `TestConnection` requests

| column | notes |
|---|---|
| `id`, `owner_user_id` | The user who made the request, even on a future shared connection |
| `connection_id`, `model_id` | Foreign keys, kept valid by tombstones (§10) |
| `chat_id`, `rollout_id`, `version_id`, `purpose` | Attribution: generation, summarize, condense, decision, test… Nullable for requests outside a chat |
| `api`, `provider`, `model_key` | What was requested |
| `response_model`, `upstream` | What served it: pi's `responseModel`, and the routed upstream where a gateway reports one (OpenRouter's `provider` field) |
| `status` | `running`, `complete`, `failed`, `aborted`, `interrupted` |
| `started_at`, `first_token_at`, `ended_at` | |
| `input_uncached`, `cache_read`, `cache_write`, `cache_write_long`, `output`, `reasoning` | Normalized counts (§9.2). `NULL` means unknown, never zero |
| `usage_source` | `reported`, `estimated` (aborted before the provider reported usage, estimated as reference-harness's `estimateAbortedRequestUsage` does) or `none` |
| `raw_usage_json` | The provider's usage object, verbatim |
| `reported_cost` | Cost as the provider reports it, when it does (OpenRouter's `usage.cost`) |
| `cost`, `cost_currency`, `cost_formula_id` | Computed when the row closes (§9.3) |

- **The row is written twice:** opened as `running` before the request is sent, and closed in one transaction with its counts and cost.
  - A crash leaves it `running`. Startup marks those `interrupted`, with unknown usage. A request that may have been billed is never silently missing.
  - Each write is one small writer operation (ARCHITECTURE §3.8 measured about 2.6 ms for an append).
- **The rollup columns on `rollouts`** (`usage_*`, `llm_requests`) and `versions.usage_json` are updated in the same transaction as the closing write, so they always match the ledger.
- **Indexes:** by `(owner_user_id, started_at)` and `(connection_id, started_at)`, for per-user and per-connection totals (and later limits).

### 9.2 Normalizing the counts

- **The normalized form:**
  - `input_uncached`: input billed at the base rate, so neither read from nor written to the cache
  - `cache_read`
  - `cache_write`: every cache write
  - `cache_write_long`: the subset of `cache_write` written with the long TTL (Anthropic's 1h). It's billed differently from 5-minute writes.
  - `output`, with `reasoning` as a subset of it
- **pi-ai already normalizes to this shape in 1.0.3,** and we verified the adapters:
  - Anthropic reports uncached input natively.
  - Chat Completions subtracts cached tokens from `prompt_tokens` wherever the provider puts them: OpenAI and OpenRouter in `prompt_tokens_details.cached_tokens`, DeepSeek in `prompt_cache_hit_tokens`, Kimi in top-level `cached_tokens`. Separate cache writes are subtracted too.
  - Google subtracts `cachedContentTokenCount`.
  - Responses reads `input_tokens_details`.
- **We rely on it, but don't trust it blindly:**
  - Each provider kind gets a test feeding recorded-shape synthetic usage chunks through pi-ai and asserting the normalized counts, so a pi-ai change that alters them fails `npm run check`.
  - `raw_usage_json` keeps the original. If a normalization turns out wrong for some upstream, past rows can be recounted from it rather than being lost. This follows "nothing is lost".

### 9.3 Cost formulas

A formula turns the counts into one number:

```
cost = (input_uncached × in + cache_read × read + (cache_write − cache_write_long) × write + cache_write_long × write_long + output × out) / 1e6
```

- **Multipliers per million tokens.** Five, not four: long cache writes need their own rate. pi-ai hardcodes them as 2× the input rate, which is Anthropic's rule, so the formula makes it explicit.
- **A currency label.** USD for all built-in data. Any other label is a display matter; nothing converts.
- **Tiers by context size.** Total input above a threshold switches to another set of multipliers for the whole request. That's how long-context pricing works, and it's the same rule as pi-ai's `ModelCost.tiers`.
- **Conditions:**
  - the provider kind or one connection
  - the exact model
  - optionally the exact upstream (an OpenRouter route)

  The most specific matching formula wins.

**Sources, in increasing precedence** [P]:
1. **Built-in:** generated from pi-ai's catalog prices (`Model.cost`, tiers included) for every model in it. They update with each pi-ai release.
2. **Provider-reported cost**, where there is one (OpenRouter): stored in `reported_cost`, and used as the displayed cost when no user formula matches, because it reflects the actual route and any discount.
3. **The user's own formulas**, for stale built-in data, a different upstream or a private contract.

**Recomputing.** A row's `cost` is what was computed when it closed, with the formula that produced it. The counts are kept, so a changed formula can be applied to past rows on request, never silently.

**Phase 0 builds:** the ledger, the normalization tests, and cost from built-in prices plus OpenRouter's reported cost. The formula table and editor come later, but the ledger already stores everything a formula needs.

---

## 10. Deleting connections and models

Versions and rollouts reference `connections(id)` and `models(id)` by foreign key, which is how a message records what generated it (DATA-MODEL §4.5, §7.1). The ledger does too.
- **Deleting** a connection goes to the recycle bin, like chats and entities (ARCHITECTURE §3.11). It stops appearing in pickers. Chats bound to it show a "connection deleted" warning at the composer instead of silently switching.
- **Purging** wipes the key, URL, proxy and headers, and keeps the row and its models as a tombstone, so old messages and ledger rows still name their model. This is the same pattern as a purged entity keeping its row.

---

## 11. pi-ai version and the patch

- **Pin `@earendil-works/pi-ai` 1.0.3,** the latest release older than the 5-day cooldown. Its dependencies (the Anthropic, OpenAI, Google and Bedrock SDKs, typebox) are pinned transitively by the lockfile.
- **No patch:**
  - `stopCategory` (reference-harness 7da8400): pi-ai still doesn't normalize it, but the public `onProviderStreamEvent` hook sees Anthropic's `message_delta.stop_details`. Refusal handling isn't phase 0 work anyway.
  - The Responses deferred-tool namespace (reference-harness 347a99b): 1.0.3 still replays a namespace only for the same model (`openai-responses-shared.js:227`). It only matters for tool search over deferred tools on Responses-compatible endpoints. Re-check in phase 4.
- **A guard test per pi-ai behavior we rely on** that isn't strongly documented. That's reference-harness's `pi-ai-deferred-namespace.test.ts` pattern: a pi-ai bump that breaks one fails `npm run check`. The behaviors:
  - placeholder keys for keyless servers
  - the `onPayload` replacement contract
  - the breakpoint index mapping
  - usage normalization per provider kind (§9.2)
  - DeepSeek's reasoning replay (§2)
  - our `fetch` being used by every API (§6.2)

---

## 12. Testing

- **Unit:** pi-ai's faux provider (`providers/faux`) for the service's stream, error mapping, retry logic and ledger writes.
- **HTTP:** a local mock endpoint for each list format, each error class (401, 429 with `Retry-After`, overflow text, mid-stream disconnect), and each provider's usage shape. This is the start of the recording endpoint the differential harness needs (PLAN phase 1).
- **Network:** route selection (bypass by hostname and by resolved IP, the override, no proxy), and an HTTP proxy and a SOCKS proxy in the test, each confirming the traffic went through it.
- **Isolation:** every new operation is run as a second user against the first user's ids and must answer `NotFound` (§6.1, priority 1).
- **No real keys in CI.** A manual script runs one request per configured connection.

---

## 13. Phase 0 scope

Built:
- Migration `0005_providers`: §2, §3.1 and §9.1.
- The secret and encryption: §5.
- Connection and model operations, model fetching for the formats in §2, and `TestConnection`.
- The network module, with the instance proxy, the bypass list and the per-connection override.
- The `Providers.stream` service, with typed errors, retries before the first token, the per-connection cap, and `anthropic-messages` explicit breakpoints.
- The ledger with normalized counts, raw usage, and built-in and reported cost.
- A minimal settings page in the client: connections and their models, adding a key, testing (with the route shown), editing a model's capabilities, and the instance network settings for admins.

Not built until needed:
- for the assembler: sampler mapping from presets, prefill, the other APIs' explicit breakpoints, the cold-cache stagger, and per-chat model bindings in the UI (the `model.binding` state event already exists, DATA-MODEL §5.3)
- user cost formulas and their editor
- shared connections and cost limits

---

## 14. Open questions

1. **Exposure rules (§6.1):** what counts as protected enough to listen beyond localhost (a password, an IP allowlist, a trusted proxy header from an allowed address), and what the override looks like. **Known gap now:** the Docker image sets `HOST=0.0.0.0` while `AUTH_MODE` defaults to `single`, which is exactly the accidental exposure to rule out. Container networking hides it only as long as the port isn't published.
2. **Forcing the proxy (§6.3):** whether an admin can stop non-admins from setting a connection to `direct`. Deferred to shared connections.
