# Effect across the stack

**Status**: Implemented portions obsolete as proposals (2026-10-30): Effect 4 HTTP/RPC, worker RPC, services/layers, schemas, client atoms and the pi-ai streaming boundary are built; see ARCHITECTURE §1–§6 and §16. `node:sqlite` through Effect’s driver is built (§3), superseding the open driver choice in §4. pi-agent-core integration and its tool-schema boundary are built with the agent rollouts (2026-11, ARCHITECTURE §16); summary tool output already works through the registered summary strategies (§16). Other conventions in §4 remain proposals beyond what CLAUDE.md requires. Original proposal/spike: 2026-10-10. Implementation is not owner confirmation; nothing is newly Decided here.
**Related**: [CLIENT-FRAMEWORK.md](CLIENT-FRAMEWORK.md), DESIGN §10.4, PLAN phase 0.

---

## 1. Why this project, unlike the earlier attempts

The owner's earlier frontends dropped Effect because they had nothing for it to manage. reference-harness's console is the measured case: about 1,400 `Schema.*` calls against roughly a dozen uses of `Effect` itself, all at one HTTP boundary.

This project is made of exactly what Effect is for:

| Requirement (DESIGN ref) | Effect mechanism |
|---|---|
| The stop button belongs to the version; any number of generations run concurrently (§3.1, §10.1) | One fiber per generation; interrupting it aborts the provider call through the `AbortSignal` that `Effect.tryPromise` hands to pi-ai |
| Failed generations are versions showing their cause: HTTP, context length, refusal with category, length cutoff (§3.1) | Typed error channel: a closed union of tagged errors, matched exhaustively when the version is written |
| Staggered parallel swipes: start one, release the others once its cache write is readable (§5.5) | Structured concurrency (`Deferred`, `Effect.forEach` with concurrency, `Semaphore`) |
| Scheduler classes `interactive` / `idle` / `background`; LCM worker pool; idle-time jobs while the cache is warm (§8, DATA-MODEL §7.1) | Fibers, `Queue`, `Schedule`, `Effect.timeout`, retry policies as values |
| Rollout resume, interruption policies (§7.5) | `Exit` and `Cause` tell interruption, defects and expected failures apart, which the recovery code needs |
| Every UI action is a typed server operation; WebSocket subscriptions (§7.7, §10.1) | `effect/rpc`: an `RpcGroup` shared by client and server over a WebSocket, with stream RPCs whose client-side interrupt reaches the server fiber |
| Validated documents and wire formats (DATA-MODEL §3.3) | Schema in core, shared by client and server, with JSON Schema output |
| Server-pushed state on the client (CLIENT-FRAMEWORK §5) | `effect/reactivity` atoms with `AtomRpc`; per-version atom families fed by stream RPCs |

---

## 2. State of Effect (2026-10-10)

- **Effect 4.0 went GA on 2026-10-01**; the current release is 4.0.2. 3.x is frozen and gets fixes only. 4.x has LTS: bug fixes until September 2029 or one year after 5.0, whichever is later.
- **v4 merged the ecosystem into core.** HTTP, RPC, SQL, reactivity (the former effect-atom), sockets and AI are now `effect/*` modules. Separate packages remain for `@effect/platform-node`, `@effect/sql-sqlite-node` and `@effect/atom-react`, all versioned in lockstep.
- **Stability tags matter.** Core (`Effect`, `Stream`, `Schema`, `JsonSchema`, …) is `stable`. **Every module we'd use beyond core (`http`, `rpc`, `sql`, `socket`, `reactivity`) is tagged `unstable` and may break in a minor release.**
- **Proven combination:** T3 Code and Hazel Chat both run Effect on the server, Effect RPC over a socket, `@effect/atom-react` and TanStack Router on the client. That's the stack proposed here.
- **Framework bindings:** official atom bindings exist for React, Solid and Vue only. **There is no official Svelte binding.**

---

## 3. Proposed shape [P]

**Server: Effect from the edge to the database.**
- Typed operations as an `RpcGroup` in a shared package; subscriptions as stream RPCs.
- `effect/http` + `@effect/platform-node` can serve RPC, the WebSocket and the static SPA, with no separate HTTP framework. *This would also settle the deferred server-HTTP question; the owner deferred it, so it stays Open until the spike in §5.*
- Services (storage, provider layer, scheduler, LCM workers) as Effect services and layers. Tests swap layers for fakes, which also gives the differential-test harness (PLAN phase 1) a clean mock-provider seam.
- pi-agent-core and pi-ai stay promise-based. They're called through `Effect.tryPromise` with the fiber's `AbortSignal`, and their async iterators are bridged with `Stream.fromAsyncIterable`. We don't rewrite the agent loop in Effect.

**Client: Effect in the data layer, plain React in components.**
- The RPC client, the WebSocket connection with reconnect and resubscribe, optimistic writes with `row_version` and rollback, and per-version streaming state all live in Effect services and atoms.
- Components read atoms through `@effect/atom-react`. They don't import `Effect` themselves.
- **TanStack Query overlaps with this.** AtomRpc already covers queries, mutations, invalidation and streams. Proposal: atoms for everything that comes over the WebSocket (nearly all state), and Query only for any plain-HTTP fetches that turn out to exist. Two caches for the same data would be a bug source.

**Schema:**
- Effect Schema for wire formats, documents and settings.
- **Implemented:** the server's own HTTP server is `effect/http` with `@effect/platform-node`, which settles the deferred server-HTTP question in practice (ARCHITECTURE.md §2). The owner can still revisit it.
- pi-ai defines tool parameters with TypeBox. At that boundary we either convert Effect Schema to JSON Schema (`Schema.toJsonSchemaDocument`) and pass it raw, or keep TypeBox just for tool definitions. To be decided when tools are built (phase 4).

---

## 4. Risks and how we'd contain them

- **`unstable` modules (rpc, http, sql, reactivity).**
  - Pin exact versions and upgrade deliberately.
  - Keep our own thin modules between app code and these APIs, so a breaking minor touches a few files.
- **SQLite driver.** `@effect/sql-sqlite-node` v4 is built on `node:sqlite`, not better-sqlite3 (which reference-harness uses).
  - FTS5 works in `node:sqlite` (checked on Node 24.15, SQLite 3.51.3).
  - Node's docs still mark `node:sqlite` as a release candidate.
  - Turso was evaluated as an alternative engine and deferred: [STORAGE.md](STORAGE.md).
  - **[O]** Choose between `node:sqlite` through the official driver, or better-sqlite3 behind our own `SqlClient` adapter. It also needs checking that extension loading (sqlite-vec, if we use it) and reference-harness's single-writer queue port cleanly.
- **Agents write v3 code by habit.** Examples: `catchAll` instead of `catch`, `Context.Tag` instead of `Context.Service`, `Either` instead of `Result`, and stale `effect/unstable/*` paths from the beta.
  - Install the official `Effect-TS/skills`.
  - State "Effect 4.x only" in CLAUDE.md.
  - Point agents at `node_modules/effect/AGENTS.md` and `ai-docs/`.
  - Run `@effect/language-service` in CI.
- **Overuse.** Effect in every component makes React code worse, not better. The boundary is the data layer (§3).
- **Streaming performance through atoms isn't benchmarked anywhere.** It must be measured in the performance harness (CLIENT-FRAMEWORK §7) before the chat view is built on it.

---

## 5. Validation: spike results (2026-10-10)

The spike is in [spikes/effect-stream](../spikes/effect-stream/README.md). It covers the four points this section originally planned.
1. **Streaming RPC with cancellation: works.**
   - 6 concurrent generations ran over a WebSocket stream RPC, with deltas coalesced into one batch per 16 ms.
   - Stopping one interrupts its fiber. The partial text is persisted (`onExit`), the provider's `AbortSignal` fires, and the provider's iterator is finalized.
   - Unsubscribing on the client stops delivery.
   - 16/16 contract checks pass.
2. **Atoms vs a plain store: no measurable difference.** Both re-render one row per update, and frame times are equal (1×: p95 16.7 ms, under 1.2% of frames over 25 ms). **Atoms stay; no bypass is needed.** The real cost is browser layout and paint of growing messages, which is a chat-view concern (CLIENT-FRAMEWORK §5, §7) and independent of Effect.
3. **Optimistic write with typed errors: works.** `rowVersion` concurrency, with `StaleWrite` and `NotFound` arriving as tagged errors, and rollback in the UI.
4. **SQLite: `node:sqlite` through `@effect/sql-sqlite-node` works** (migrations, transactions, `RETURNING`, STRICT). This supports the [STORAGE.md](STORAGE.md) proposal.

Follow-ups the spike surfaced:
- **[P]** Subscriptions need a per-chat event sequence number, so a client can subscribe from a cursor without losing events between its initial load and subscribing.
- AtomRpc's `mutation` helper isn't concurrent. Use `runtime.fn` with `concurrent: true` for parallel operations.
- Components using TanStack Virtual need `"use no memo"` under React Compiler.

---

## 6. Sources

Facts checked 2026-10-10 against the npm registry and the published `effect@4.0.2`, `@effect/platform-node@4.0.2` and `@effect/sql-sqlite-node@4.0.2` packages (module `@stability` tags read from source).
- Effect 4.0 release: https://effect.website/blog/releases/effect/40 · beta post: https://effect.website/blog/releases/effect/40-beta
- v3 → v4 migration (module moves, renames): https://github.com/Effect-TS/effect/blob/main/MIGRATION.md
- AtomRpc: https://effect.website/docs/v4/api/effect/unstable/reactivity/AtomRpc
- Agent material: https://github.com/Effect-TS/skills · https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive/
- `node:sqlite` status: https://nodejs.org/api/sqlite.html
- Reference apps: https://github.com/pingdotgg/t3code · https://github.com/HazelChat/hazel
- The counter-view: https://runharbor.com/blog/2025-11-24-why-we-dont-use-effect-ts
- reference-harness console usage counted locally (`console/src`, 2026-10-10)
