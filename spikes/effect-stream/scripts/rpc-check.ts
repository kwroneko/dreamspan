// Headless checks of the server contract, using the same RPC client the browser uses.
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Fiber, Layer, Stream } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { ChatApi, type ChatEvent } from "../src/shared/api.ts"

const url = process.env.RPC_URL ?? "ws://localhost:47100/rpc"

const Protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket(url)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerJson)
)

const check = (label: string, ok: boolean, detail = "") =>
  Effect.sync(() => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`)
    if (!ok) process.exitCode = 1
  })

const program = Effect.gen(function*() {
  const client = yield* RpcClient.make(ChatApi)

  // Collect everything the subscription delivers.
  const received: Array<ReadonlyArray<ChatEvent>> = []
  const subscription = yield* client.Subscribe({ chatId: "c1" }).pipe(
    Stream.runForEach((batch) => Effect.sync(() => received.push(batch))),
    Effect.forkScoped
  )
  yield* Effect.sleep("100 millis")

  // Six concurrent generations: three parallel versions under one slot, three elsewhere.
  const slots = ["s9999", "s9999", "s9999", "s9998", "s9997", "s9996"]
  const versions = yield* Effect.forEach(
    slots,
    (slotId) => client.Generate({ slotId, tokensPerSecond: 50, tokens: 100 }),
    { concurrency: "unbounded" }
  )
  yield* check("6 generations started", versions.length === 6)

  // Stop two mid-stream.
  yield* Effect.sleep("700 millis")
  const stopped = yield* Effect.forEach([versions[1]!, versions[4]!], (v) => client.Stop({ versionId: v.id }))
  yield* check("Stop reports a running generation", stopped.every(Boolean))
  const stopAgain = yield* client.Stop({ versionId: versions[1]!.id })
  yield* check("Stop on a finished generation reports false", stopAgain === false)

  // Let the rest finish (100 tokens at 50/s = 2 s).
  yield* Effect.sleep("2500 millis")
  const stats = yield* client.ProviderStats()
  yield* check(
    "AbortSignal reached the promise-based provider for stopped generations",
    stats.aborted === 2 && stats.completed === 4,
    JSON.stringify(stats)
  )
  yield* check("every provider iterator was finalized (no leaked generators)", stats.closed === stats.started)

  // Streamed deltas must reassemble into exactly what was persisted.
  const events = received.flat()
  const slotsNow = yield* client.ListSlots({ chatId: "c1" })
  const persisted = new Map(slotsNow.flatMap((s) => s.versions).map((v) => [v.id, v]))
  for (const v of versions) {
    const streamed = events.filter((e) => e._tag === "Delta" && e.versionId === v.id)
      .map((e) => (e as Extract<ChatEvent, { _tag: "Delta" }>).text).join("")
    const final = persisted.get(v.id)!
    const status = events.findLast((e) => e._tag === "StatusChanged" && e.versionId === v.id)
    yield* check(
      `version ${v.id.slice(-8)}: streamed text equals persisted text, status ${final.status}`,
      streamed === final.content && status?._tag === "StatusChanged" && status.status === final.status,
      `${streamed.length} chars`
    )
  }
  const deltas = events.filter((e) => e._tag === "Delta").length
  yield* check(
    "server coalesces deltas into batches",
    received.length < deltas,
    `${received.length} batches carrying ${deltas} deltas`
  )

  // Optimistic concurrency with typed errors.
  const target = persisted.get("v42")!
  const edited = yield* client.EditVersion({ versionId: "v42", content: "edited", expectedRowVersion: target.rowVersion })
  yield* check("edit with current rowVersion succeeds", edited.rowVersion === target.rowVersion + 1)
  yield* client.TouchVersion({ versionId: "v42" })
  const stale = yield* client.EditVersion({ versionId: "v42", content: "lost", expectedRowVersion: edited.rowVersion }).pipe(
    Effect.map(() => "no error"),
    Effect.catchTag("StaleWrite", (e) => Effect.succeed(`StaleWrite expected=${e.expected} actual=${e.actual}`))
  )
  yield* check("edit with stale rowVersion fails with typed StaleWrite", stale.startsWith("StaleWrite"), stale)
  const missing = yield* client.EditVersion({ versionId: "nope", content: "x", expectedRowVersion: 1 }).pipe(
    Effect.map(() => "no error"),
    Effect.catchTag("NotFound", (e) => Effect.succeed(`NotFound ${e.id}`))
  )
  yield* check("edit of a missing version fails with typed NotFound", missing === "NotFound nope")

  // Client-side interrupt of a stream RPC: unsubscribe, then confirm new events no longer arrive.
  yield* Fiber.interrupt(subscription)
  const before = received.length
  yield* client.Generate({ slotId: "s1", tokensPerSecond: 100, tokens: 20 })
  yield* Effect.sleep("400 millis")
  yield* check("interrupting the client stream stops delivery", received.length === before)
}).pipe(Effect.scoped, Effect.provide(Protocol))

NodeRuntime.runMain(program)
