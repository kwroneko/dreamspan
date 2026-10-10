# Spike: Effect 4 streaming, atoms vs plain store, node:sqlite

**Status**: Done, 2026-10-10. Throwaway code. It validates [spec/EFFECT.md](../../spec/EFFECT.md) §5 and feeds CLIENT-FRAMEWORK §7 (the performance harness). The findings are summarized in EFFECT.md §5.

## What it is

- **Server** (`src/server`):
  - Effect 4 RPC over a WebSocket, using `effect/http`, `@effect/platform-node` and `RpcServer.layerHttp`
  - SQLite through `@effect/sql-sqlite-node` (`node:sqlite`), seeded with a 10k-slot chat
  - a fake promise-based provider shaped like pi-ai: an async iterator plus an `AbortSignal`
  - one fiber per generation in a `FiberMap`
  - a `PubSub` fanned out to subscribers, with deltas coalesced into one batch per 16 ms
- **Client** (`src/client`):
  - React 19.3 with React Compiler 1.0 (Babel), Vite 8
  - TanStack Virtual chat mode (`anchorTo: "end"`, `followOnAppend`)
  - an `AtomRpc` client
  - two interchangeable per-version stores, chosen by `?store=atom|plain`
  - optimistic edit with `rowVersion` and rollback on a typed `StaleWrite`
- **Scripts:**
  - `rpc-check.ts`: headless contract checks (16)
  - `measure.ts`: Playwright scenarios with budget-style metrics
  - `profile.ts`: CPU profile by self time
  - `trace.ts`: browser trace by main-thread event

```bash
npm install
npm run check      # needs `npm run server` running in another terminal
npm run measure    # builds, then spawns its own server and preview per scenario
```

Versions are pinned exactly. The host's package-manager guard (pmg) enforces a 5-day cooldown, so `effect` is 4.0.1 rather than 4.0.2.

## Results

**Contract checks (`rpc-check.ts`): 16/16 pass.**
- **Concurrent generations:** 6 at once (three under one slot), each stoppable on its own.
- **Stopping:**
  - Interrupting the generation fiber persists the partial text with status `stopped`, because `Effect.onExit` runs uninterruptibly.
  - The provider's `AbortSignal` fires for exactly the stopped calls.
  - Every provider iterator is finalized: `Stream.fromAsyncIterable` calls `return()`, and our scope's AbortController is released after that.
- **Delta integrity:** the streamed deltas reassemble into exactly the persisted text, for every version.
- **Batching:** 465 deltas arrived in 96 batches.
- **Typed errors across the wire:** `StaleWrite { expected, actual }` and `NotFound` reach the client as tagged errors and are handled with `catchTag`.
- **Unsubscribing:** interrupting the client-side stream stops delivery.

**UI under load (`measure.ts`).**
- **Workload:** 6 streams at 300 tok/s each for 10 s (18,000 deltas), with typing in the composer throughout, then scrolling up into history mid-stream.
- **Setup:** headless Chromium at 1280×900, production build, 10k-slot chat.
- **Machine:** the 48-core host at load ~20 after the owner stopped their eval jobs. Two runs agreed.

| store | CPU | frame p95 | frames > 25 ms | long frames | input p95 | renders per row update | pinned to bottom | anchor drift on scroll-up |
|---|---|---|---|---|---|---|---|---|
| atoms | 1× | 16.7 ms | 0.9% | 0 | 40 ms | 1.0 | yes | 0 px |
| plain | 1× | 16.8 ms | 1.2% | 0 | 40 ms | 1.0 | yes | 0 px |
| atoms | 4× | 33.3 ms | 13.7% | 5 | 56 ms | 1.0 | yes | 0 px |
| plain | 4× | 33.4 ms | 12.4% | 2 | 56 ms | 1.0 | yes (one 23 px frame) | 0 px |

"Input p95" is Event Timing duration, which includes waiting for the next paint, so about 16–33 ms of it is frame alignment.

## Findings

1. **Effect atoms cost nothing measurable compared with a hand-written store.** Both re-render exactly one row per update, and frame and input numbers are within noise. There's no need to bypass atoms for token deltas (EFFECT.md §5's fallback isn't needed).
2. **JavaScript isn't the bottleneck; layout and paint are.**
   - The first version rendered each message as one growing text node. That cost about 17% frames over 25 ms even at 1×, and the profile was 54% native rendering work, with React and Effect at a few percent (`decode` at 0.4%).
   - Splitting messages into stable paragraphs with only the last one growing, plus `contain: layout paint style` on rows, brought 1× down to under 1%.
   - What remains at 4× (a phone-class CPU) is paint, plus the virtualizer's ResizeObserver re-measuring growing rows every frame (a trace showed 0.6 s paint and 0.46 s ResizeObserver per 5 s).
   - These are the next optimizations for the phase 2 chat view: isolate streaming rows into their own compositor layers, and throttle or batch measurement of the streaming row.
3. **TanStack Virtual's chat mode does its job:** zero anchor drift when scrolling up while rows grow below, and it stays pinned at the bottom while following.
4. **Gotchas found:**
   - **AtomRpc's `mutation` helper isn't concurrent.** A second call interrupts the first. Use `runtime.fn(..., { concurrent: true })` for anything that can run in parallel (Generate).
   - **React Compiler and `useVirtualizer` don't mix.** The virtualizer instance is mutable, so components using it need `"use no memo"`.
   - **Subscribing after listing races.** Events published between `ListSlots` and `Subscribe` are lost. The real protocol needs a per-chat event sequence number: subscribe from a cursor, and the server replays the gap.
   - **Playwright's `page.evaluate` breaks under tsx.** tsx injects a `__name` helper, which needs a one-line init-script shim.
5. **Agent ergonomics.**
   - All Effect 4 code was written from the docs bundled in `node_modules/effect` (`AGENTS.md`, `ai-docs/`, module sources) rather than from memory.
   - It typechecked on the first try. The only errors were two `noUncheckedIndexedAccess` index accesses.
   - TypeScript 7.0 (the native compiler) worked without changes.
6. **Bundle size:** 432 KB, or 136 KB gzipped, for React plus Effect (RPC, Schema, Stream, atoms) plus TanStack Virtual.
7. **node:sqlite via the Effect driver:**
   - It seeded 10k slots in one transaction in about a second.
   - `RETURNING`, STRICT tables and `withTransaction` worked.
   - Migrations ran through `SqliteMigrator`.

## Not covered

- markdown rendering (Streamdown or similar) and its cost while streaming
- prepending older history (all 10k slots load at once here)
- real phones (CPU throttling is only a stand-in)
- the real provider; the owner's local model (10k prefill, 300 tok/s decode at batch size 1) sets the 300 tok/s stress rate used here
- reconnect behavior
- memory over long sessions
