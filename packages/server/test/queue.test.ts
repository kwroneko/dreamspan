// The send queue (DESIGN §2.2): what's sent, or asked for, while a reply is still being
// written waits on the server and posts when that reply ends, after whichever version is
// selected, whether it finished, was stopped or failed. A reply that went to the bin
// withdraws it; a restart posts it without replies. The generator here only ends when the
// test says so, so every ordering is the test's.
import { assert, describe, it } from "@effect/vitest"
import type { Chat, PathEntry, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { Deferred, Effect, Layer, Option, Stream } from "effect"
import { GenerationFailed, Generator } from "../src/chat/Generator.ts"
import { client, outcome, posted, serverLayer, testConfig } from "./support/config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

/** Each generation writes a line, then waits for its gate: released, it ends; failed, it fails. */
const gates = new Map<string, Deferred.Deferred<void, GenerationFailed>>()
const gated = Layer.succeed(Generator)(
  Option.some({
    generate: (request) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void, GenerationFailed>()
          gates.set(request.versionId, gate)
          return Stream.concat(
            Stream.make("A line of the reply. "),
            Stream.fromEffect(Deferred.await(gate)).pipe(Stream.map(() => "The end."))
          )
        })
      )
  })
)

const eventually = (check: () => boolean, ms = 10_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("timed out waiting"))
      yield* Effect.sleep(10)
    }
  })

const gate = (versionId: VersionId) =>
  Effect.gen(function* () {
    yield* eventually(() => gates.has(versionId))
    return gates.get(versionId)!
  })
const release = (versionId: VersionId) => Effect.flatMap(gate(versionId), (g) => Deferred.succeed(g, undefined))
const failWith = (versionId: VersionId) =>
  Effect.flatMap(gate(versionId), (g) => Deferred.fail(g, new GenerationFailed({ class: "http", message: "502" })))

const subscribe = (api: Api, chatId: Chat["id"]) =>
  Effect.gen(function* () {
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    return events
  })

const lastQueue = (events: ReadonlyArray<ChatEvent>) =>
  events.flatMap((e) => (e._tag === "Queue" ? [e.queue] : [])).at(-1)

const path = (api: Api, chatId: Chat["id"]) =>
  Effect.map(
    api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 50 }),
    (window) => window.entries
  )

const describeEntry = (e: PathEntry) =>
  e.version.writer === "human" ? `you: ${e.version.content}` : `model (${e.version.status})`

/** A chat with a message and a reply generating under it. */
const generatingChat = (api: Api) =>
  Effect.gen(function* () {
    const chat = yield* api.CreateChat({ title: "Queue" })
    const sent = yield* posted(api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "m0" }))
    const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
    return { chat, reply: reply.entry }
  })

/** Waits until the chat's path reads as `expected`, and returns it. */
const pathBecomes = (api: Api, chatId: Chat["id"], expected: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    let entries: ReadonlyArray<PathEntry> = []
    const deadline = Date.now() + 10_000
    while (true) {
      entries = yield* path(api, chatId)
      const shown = entries.map(describeEntry)
      if (JSON.stringify(shown) === JSON.stringify(expected)) return entries
      if (Date.now() > deadline) assert.deepStrictEqual(shown, expected)
      yield* Effect.sleep(20)
    }
  })

describe("send queue", () => {
  it.live("a message sent during a reply waits, then posts after it with a reply of its own", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, reply } = yield* generatingChat(api)
      const events = yield* subscribe(api, chat.id)
      const queued = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: reply.slotId,
        branch: false,
        content: "m1"
      })
      assert.strictEqual(queued._tag, "Queued")
      assert.deepStrictEqual(
        (yield* api.ListQueued({ chatId: chat.id })).map((q) => [q.kind, q.content, q.replySlotId]),
        [["message", "m1", reply.slotId]]
      )
      yield* eventually(() => lastQueue(events)?.length === 1)
      // Nothing posts while the reply is being written.
      yield* Effect.sleep(100)
      assert.lengthOf(yield* path(api, chat.id), 2)

      yield* release(reply.version.id)
      const entries = yield* pathBecomes(api, chat.id, ["you: m0", "model (complete)", "you: m1", "model (generating)"])
      assert.strictEqual(entries[2]!.parentSlotId, reply.slotId)
      yield* eventually(() => lastQueue(events)?.length === 0)
      assert.lengthOf(yield* api.ListQueued({ chatId: chat.id }), 0)
      // The posted reply streams, and ends like any other.
      yield* release(entries[3]!.version.id)
      yield* pathBecomes(api, chat.id, ["you: m0", "model (complete)", "you: m1", "model (complete)"])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  it.live("several entries post one reply at a time, and Generate queues under the same rule", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, reply } = yield* generatingChat(api)
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: reply.slotId, branch: false, content: "m1" })
      const generate = yield* api.Generate({
        chatId: chat.id,
        parentSlotId: reply.slotId,
        branch: false,
        direction: "Keep it short."
      })
      assert.strictEqual(generate._tag, "Queued")
      yield* release(reply.version.id)
      let entries = yield* pathBecomes(api, chat.id, ["you: m0", "model (complete)", "you: m1", "model (generating)"])
      // The queued Generate waits for m1's reply, then is a reply with its direction.
      assert.deepStrictEqual(
        (yield* api.ListQueued({ chatId: chat.id })).map((q) => [q.kind, q.replySlotId]),
        [["generate", entries[3]!.slotId]]
      )
      yield* release(entries[3]!.version.id)
      entries = yield* pathBecomes(api, chat.id, [
        "you: m0",
        "model (complete)",
        "you: m1",
        "model (complete)",
        "model (generating)"
      ])
      assert.strictEqual(entries[4]!.version.direction, "Keep it short.")
      assert.isNull(entries[3]!.version.direction)
      yield* release(entries[4]!.version.id)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  it.live("a stopped reply posts the queue right after the stopped version", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, reply } = yield* generatingChat(api)
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: reply.slotId, branch: false, content: "m1" })
      yield* gate(reply.version.id)
      const stopped = yield* api.StopGeneration({ versionId: reply.version.id })
      assert.strictEqual(stopped.status, "stopped")
      const entries = yield* pathBecomes(api, chat.id, ["you: m0", "model (stopped)", "you: m1", "model (generating)"])
      yield* release(entries[3]!.version.id)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  it.live("a failed reply posts the queue after it, and stays out of the context", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, reply } = yield* generatingChat(api)
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: reply.slotId, branch: false, content: "m1" })
      yield* failWith(reply.version.id)
      const entries = yield* pathBecomes(api, chat.id, ["you: m0", "model (failed)", "you: m1", "model (generating)"])
      assert.isFalse(entries[1]!.inContext)
      yield* release(entries[3]!.version.id)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  it.live("a queued message can be edited or withdrawn until it posts", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, reply } = yield* generatingChat(api)
      const first = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: reply.slotId,
        branch: false,
        content: "typo"
      })
      const second = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: reply.slotId,
        branch: false,
        content: "never"
      })
      if (first._tag !== "Queued" || second._tag !== "Queued") return assert.fail("both should queue")
      const edited = yield* api.EditQueued({
        queuedId: first.queued.id,
        content: "fixed",
        speakerEntityId: null,
        expectedRowVersion: first.queued.rowVersion
      })
      assert.strictEqual(edited.rowVersion, first.queued.rowVersion + 1)
      assert.strictEqual(
        yield* outcome(
          api.EditQueued({
            queuedId: first.queued.id,
            content: "stale tab",
            speakerEntityId: null,
            expectedRowVersion: first.queued.rowVersion
          })
        ),
        "StaleWrite"
      )
      const withdrawn = yield* api.WithdrawQueued({ queuedId: second.queued.id })
      assert.strictEqual(withdrawn.content, "never")
      assert.strictEqual(yield* outcome(api.WithdrawQueued({ queuedId: second.queued.id })), "NotFound")
      yield* release(reply.version.id)
      const entries = yield* pathBecomes(api, chat.id, [
        "you: m0",
        "model (complete)",
        "you: fixed",
        "model (generating)"
      ])
      // Once posted it's a message, no longer a queued one.
      assert.strictEqual(yield* outcome(api.WithdrawQueued({ queuedId: first.queued.id })), "NotFound")
      assert.lengthOf(yield* api.ListQueued({ chatId: chat.id }), 0)
      yield* release(entries[3]!.version.id)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  it.live("deleting the reply withdraws what waited for it, and subscribers hear it", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, reply } = yield* generatingChat(api)
      const events = yield* subscribe(api, chat.id)
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: reply.slotId, branch: false, content: "m1" })
      yield* eventually(() => lastQueue(events)?.length === 1)
      yield* api.DeleteMessage({ slotId: reply.slotId })
      yield* eventually(() => lastQueue(events)?.length === 0)
      assert.lengthOf(yield* api.ListQueued({ chatId: chat.id }), 0)
      assert.deepStrictEqual((yield* path(api, chat.id)).map(describeEntry), ["you: m0"])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  it.live("a restart interrupts the reply and posts the queued messages, without replies", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const chatId = yield* Effect.gen(function* () {
        const api = yield* client()
        const { chat, reply } = yield* generatingChat(api)
        yield* api.SendMessage({ chatId: chat.id, parentSlotId: reply.slotId, branch: false, content: "m1" })
        yield* api.Generate({ chatId: chat.id, parentSlotId: reply.slotId, branch: false })
        yield* api.SendMessage({ chatId: chat.id, parentSlotId: reply.slotId, branch: false, content: "m2" })
        assert.lengthOf(yield* api.ListQueued({ chatId: chat.id }), 3)
        return chat.id
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config, gated)))

      yield* Effect.gen(function* () {
        const api = yield* client()
        // Nothing generates by itself after a restart: no one is there to pay for it.
        assert.deepStrictEqual((yield* path(api, chatId)).map(describeEntry), [
          "you: m0",
          "model (interrupted)",
          "you: m1",
          "you: m2"
        ])
        assert.lengthOf(yield* api.ListQueued({ chatId }), 0)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config, gated)))
    })
  })

  it.live("a message onto a finished reply posts at once", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, reply } = yield* generatingChat(api)
      yield* release(reply.version.id)
      yield* pathBecomes(api, chat.id, ["you: m0", "model (complete)"])
      const sent = yield* api.SendMessage({ chatId: chat.id, parentSlotId: reply.slotId, branch: false, content: "m1" })
      assert.strictEqual(sent._tag, "Posted")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  it.live("Regenerate keeps the speaker and direction of the version it replaces", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Directions" })
      const sent = yield* posted(api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "m0" }))
      const reply = yield* posted(
        api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false, direction: "Whisper." })
      )
      assert.strictEqual(reply.entry.version.direction, "Whisper.")
      yield* release(reply.entry.version.id)
      yield* pathBecomes(api, chat.id, ["you: m0", "model (complete)"])
      const [, current] = yield* path(api, chat.id)
      const swipe = yield* api.Regenerate({ slotId: current!.slotId, expectedRowVersion: current!.rowVersion })
      assert.strictEqual(swipe.version.direction, "Whisper.")
      // A later turn doesn't inherit it.
      yield* release(swipe.version.id)
      yield* pathBecomes(api, chat.id, ["you: m0", "model (complete)"])
      const next = yield* posted(
        api.Generate({ chatId: chat.id, parentSlotId: current!.slotId as SlotId, branch: false })
      )
      assert.isNull(next.entry.version.direction)
      yield* release(next.entry.version.id)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )
})
