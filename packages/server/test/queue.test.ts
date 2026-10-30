// The send queue (DESIGN §2.2): what's sent, or asked for, while a reply is still being
// written waits on the server and posts when that reply ends, after whichever version is
// selected, whether it finished, was stopped or failed. A reply that went to the bin
// withdraws it; a restart posts it without replies. The generator here only ends when the
// test says so, so every ordering is the test's.
import { assert, describe, it } from "@effect/vitest"
import type { Chat, PathEntry, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { Deferred, Effect, Layer, Option, Stream } from "effect"
import { Writer } from "../src/db/Database.ts"
import { GenerationFailed, Generator } from "../src/chat/Generator.ts"
import { client, outcome, posted, serverLayer, testConfig, takenFrom, typeInto } from "./support/config.ts"
import { deleteBranchBelow } from "./support/forkIds.ts"

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
  for (const cleanup of ["restore", "purge", "restart"] as const) {
    it.live(`${cleanup} before a deleted generation finishes recovers its unposted queue`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const writer = yield* Writer
        const user = yield* api.Whoami()
        const { chat, reply } = yield* generatingChat(api)
        yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: reply.slotId,
          branch: false,
          content: "unposted before cleanup"
        })
        yield* gate(reply.version.id)
        // Exercise the writer-to-generation gap without letting the delete RPC stop it first.
        const item = yield* writer.DeleteMessage({ userId: user.id, slotId: reply.slotId })
        if (cleanup === "restore") yield* api.RestoreBinItem({ itemId: item.id })
        else if (cleanup === "purge") yield* api.PurgeBinItem({ itemId: item.id })
        else yield* writer.InterruptGenerations()
        assert.deepStrictEqual(yield* api.ListQueued({ chatId: chat.id }), [])
        assert.include(
          (yield* api.ListRecoveredTexts({ limit: 100, before: null })).map((r) => r.content),
          "unposted before cleanup"
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
    )
  }

  it.live("withdrawing a queued direction retains it if the caller leaves before copying it", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, reply } = yield* generatingChat(api)
      const queued = yield* api.Generate({
        chatId: chat.id,
        parentSlotId: reply.slotId,
        branch: false,
        direction: "withdrawn direction"
      })
      if (queued._tag !== "Queued") return assert.fail("it should queue")
      yield* api.WithdrawQueued({ queuedId: queued.queued.id, expectedRowVersion: queued.queued.rowVersion })
      assert.deepStrictEqual(yield* api.ListQueued({ chatId: chat.id }), [])
      assert.include(
        (yield* api.ListRecoveredTexts({ limit: 100, before: null })).map((r) => r.content),
        "withdrawn direction"
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  for (const deletion of ["message", "branch", "chat"] as const) {
    it.live(`deleting a streaming ${deletion} recovers committed queue text and directions before removing them`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const { chat, reply } = yield* generatingChat(api)
        const text = "committed queued message"
        const direction = "committed queued direction"
        const draft = yield* typeInto(api, chat.id, null, text)
        const first = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: reply.slotId,
          branch: false,
          content: text,
          composer: takenFrom(draft)
        })
        assert.strictEqual(first._tag, "Queued")
        const next = yield* typeInto(api, chat.id, null, direction, first.draft!)
        assert.strictEqual(
          (yield* api.Generate({
            chatId: chat.id,
            parentSlotId: reply.slotId,
            branch: false,
            direction,
            composer: takenFrom(next)
          }))._tag,
          "Queued"
        )
        yield* gate(reply.version.id)
        const item =
          deletion === "message"
            ? yield* api.DeleteMessage({ slotId: reply.slotId })
            : deletion === "branch"
              ? yield* deleteBranchBelow(api, chat.id, null)
              : yield* api.DeleteChat({ chatId: chat.id })
        yield* api.RestoreBinItem({ itemId: item.id })
        assert.deepStrictEqual(yield* api.ListQueued({ chatId: chat.id }), [])
        const recovered = yield* api.ListRecoveredTexts({ limit: 100, before: null })
        assert.includeMembers(
          recovered.map((r) => r.content),
          [text, direction]
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
    )
  }

  it.live("a restart recovers queued directions while posting committed messages without replies", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const chatId = yield* Effect.gen(function* () {
        const api = yield* client()
        const { chat, reply } = yield* generatingChat(api)
        const draft = yield* typeInto(api, chat.id, null, "queued message")
        const first = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: reply.slotId,
          branch: false,
          content: "queued message",
          composer: takenFrom(draft)
        })
        const next = yield* typeInto(api, chat.id, null, "restart direction", first.draft!)
        yield* api.Generate({
          chatId: chat.id,
          parentSlotId: reply.slotId,
          branch: false,
          direction: "restart direction",
          composer: takenFrom(next)
        })
        return chat.id
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config, gated)))
      yield* Effect.gen(function* () {
        const api = yield* client()
        assert.deepStrictEqual(yield* api.ListQueued({ chatId }), [])
        assert.include(
          (yield* path(api, chatId)).map((e) => e.version.content),
          "queued message"
        )
        assert.include(
          (yield* api.ListRecoveredTexts({ limit: 100, before: null })).map((r) => r.content),
          "restart direction"
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config, gated)))
    })
  })

  it.live("background queue posting goes on in the fork it was sent in, with that fork's composer", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, reply } = yield* generatingChat(api)
      const fork = (yield* api.GetChat({ chatId: chat.id })).currentForkId!
      const [root] = yield* path(api, chat.id)
      const draft = yield* typeInto(api, chat.id, null, "queued")
      const sent = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: reply.slotId,
        branch: false,
        content: "queued",
        composer: takenFrom(draft)
      })
      const typing = yield* typeInto(api, chat.id, null, "next turn", sent.draft!)
      const other = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: root!.slotId, branch: true, content: "other" })
      )
      assert.notStrictEqual(other.chat.currentForkId, fork)
      yield* gate(reply.version.id)
      yield* api.StopGeneration({ versionId: reply.version.id })
      while ((yield* api.ListQueued({ chatId: chat.id })).length > 0) yield* Effect.sleep(10)
      // Posted where it was sent; the chat stays where the user went since.
      const shown = yield* api.ReadPath({
        chatId: chat.id,
        forkId: fork,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 50
      })
      assert.include(
        shown.entries.map((e) => e.version.content),
        "queued"
      )
      assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).currentForkId, other.chat.currentForkId)
      const kept = yield* api.OpenComposer({ chatId: chat.id, forkId: fork })
      assert.deepStrictEqual([kept.id, kept.content], [typing.id, "next turn"])
      const elsewhere = yield* api.OpenComposer({ chatId: chat.id, forkId: other.chat.currentForkId })
      assert.deepStrictEqual([elsewhere.id === typing.id, elsewhere.content], [false, ""])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

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

  it.live("a message queued with no one to reply posts alone, and the entries after it post on from it", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, reply } = yield* generatingChat(api)
      // Every character muted (DESIGN §3.5): the composer asks for no reply.
      const muted = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: reply.slotId,
        branch: false,
        content: "m1",
        reply: false
      })
      assert.strictEqual(muted._tag, "Queued")
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: reply.slotId,
        branch: false,
        content: "m2",
        reply: false
      })
      yield* release(reply.version.id)
      yield* pathBecomes(api, chat.id, ["you: m0", "model (complete)", "you: m1", "you: m2"])
      assert.lengthOf(yield* api.ListQueued({ chatId: chat.id }), 0)
      // Nothing else starts: no reply was asked for.
      yield* Effect.sleep(100)
      assert.lengthOf(yield* path(api, chat.id), 4)

      // A muted message ahead of one that wants a reply: the reply follows the later one.
      const second = yield* posted(
        api.Generate({ chatId: chat.id, parentSlotId: (yield* path(api, chat.id))[3]!.slotId, branch: false })
      )
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: second.entry.slotId,
        branch: false,
        content: "m3",
        reply: false
      })
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: second.entry.slotId, branch: false, content: "m4" })
      yield* release(second.entry.version.id)
      const entries = yield* pathBecomes(api, chat.id, [
        "you: m0",
        "model (complete)",
        "you: m1",
        "you: m2",
        "model (complete)",
        "you: m3",
        "you: m4",
        "model (generating)"
      ])
      assert.lengthOf(yield* api.ListQueued({ chatId: chat.id }), 0)
      yield* release(entries[7]!.version.id)
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
      const withdrawn = yield* api.WithdrawQueued({ queuedId: second.queued.id, expectedRowVersion: 1 })
      assert.strictEqual(withdrawn.content, "never")
      assert.strictEqual(
        yield* outcome(api.WithdrawQueued({ queuedId: second.queued.id, expectedRowVersion: 1 })),
        "NotFound"
      )
      yield* release(reply.version.id)
      const entries = yield* pathBecomes(api, chat.id, [
        "you: m0",
        "model (complete)",
        "you: fixed",
        "model (generating)"
      ])
      // Once posted it's a message, no longer a queued one.
      assert.strictEqual(
        yield* outcome(api.WithdrawQueued({ queuedId: first.queued.id, expectedRowVersion: edited.rowVersion })),
        "NotFound"
      )
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

  it.live("withdrawing as an older view of the entry is refused, so another tab's edit isn't lost", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, reply } = yield* generatingChat(api)
      const queued = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: reply.slotId,
        branch: false,
        content: "old"
      })
      if (queued._tag !== "Queued") return assert.fail("it should queue")
      // Another tab edits it.
      yield* api.EditQueued({
        queuedId: queued.queued.id,
        content: "newer",
        speakerEntityId: null,
        expectedRowVersion: queued.queued.rowVersion
      })
      assert.strictEqual(
        yield* outcome(
          api.WithdrawQueued({ queuedId: queued.queued.id, expectedRowVersion: queued.queued.rowVersion })
        ),
        "StaleWrite"
      )
      assert.deepStrictEqual(
        (yield* api.ListQueued({ chatId: chat.id })).map((q) => q.content),
        ["newer"]
      )
      yield* release(reply.version.id)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  it.live("selecting a finished version of the reply posts the queue at once", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, reply } = yield* generatingChat(api)
      yield* release(reply.version.id)
      const [, finished] = yield* pathBecomes(api, chat.id, ["you: m0", "model (complete)"])
      const swipe = yield* api.Regenerate({ slotId: reply.slotId, expectedRowVersion: finished!.rowVersion })
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: reply.slotId, branch: false, content: "m1" })
      // Back to the finished version while the swipe still generates: nothing to wait for.
      yield* api.SelectVersion({
        slotId: reply.slotId,
        versionId: finished!.version.id,
        expectedVersionId: swipe.version.id
      })
      const entries = yield* pathBecomes(api, chat.id, ["you: m0", "model (complete)", "you: m1", "model (generating)"])
      assert.lengthOf(yield* api.ListQueued({ chatId: chat.id }), 0)
      // A later send to the old reply hears that the chat moved on, rather than forking it away.
      assert.strictEqual(
        yield* outcome(
          api.SendMessage({ chatId: chat.id, parentSlotId: reply.slotId, branch: false, content: "late" })
        ),
        "LeafMoved"
      )
      yield* release(swipe.version.id)
      yield* release(entries[3]!.version.id)
      yield* pathBecomes(api, chat.id, ["you: m0", "model (complete)", "you: m1", "model (complete)"])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  it.live("a queued message posts on its own branch when the user has moved to another", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, reply } = yield* generatingChat(api)
      const [m0] = yield* path(api, chat.id)
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: reply.slotId, branch: false, content: "queued" })
      // Meanwhile the user starts another branch from m0, and stays there.
      const elsewhere = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: m0!.slotId, branch: true, content: "elsewhere" })
      )
      yield* release(reply.version.id)
      let queued: ReadonlyArray<unknown> = [1]
      while (queued.length > 0) {
        queued = yield* api.ListQueued({ chatId: chat.id })
        yield* Effect.sleep(20)
      }
      // The chat is still where the user is; the queued message posted after the reply.
      assert.deepStrictEqual((yield* path(api, chat.id)).map(describeEntry), ["you: m0", "you: elsewhere"])
      assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId, elsewhere.entry.slotId)
      const there = yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: null,
        range: { _tag: "Around", slot: reply.slotId },
        limit: 10
      })
      assert.deepStrictEqual(there.entries.map(describeEntry), [
        "you: m0",
        "model (complete)",
        "you: queued",
        "model (generating)"
      ])
      yield* release(there.entries[3]!.version.id)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

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

  it.live("Regenerate keeps the speaker of the version it replaces, and only a direction given with it", () =>
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
      // Nothing is reused (DESIGN §2.2, the guidance toggle): a swipe has the direction it's given.
      const swipe = yield* api.Regenerate({
        slotId: current!.slotId,
        expectedRowVersion: current!.rowVersion,
        direction: "Shout."
      })
      assert.strictEqual(swipe.version.direction, "Shout.")
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

  // Inserting messages (spec/MESSAGE-INSERT.md §5): the queue waits only behind its own slot.
  it.live("a generation at an inserted message holds neither the composer nor the queue", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, reply } = yield* generatingChat(api)
      yield* release(reply.version.id)
      const [m0] = yield* pathBecomes(api, chat.id, ["you: m0", "model (complete)"])
      const forkId = (yield* api.GetChat({ chatId: chat.id })).currentForkId!
      const inserted = yield* api.InsertMessage({
        chatId: chat.id,
        forkId,
        anchor: m0!.slotId,
        expectedRowVersion: m0!.rowVersion,
        body: { _tag: "Generate", speaker: null }
      })
      yield* gate(inserted.entry.version.id)
      // Sent at the tip while it's written: posted at once, and so is the reply asked for.
      const sent = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: reply.slotId, branch: false, content: "m1" })
      )
      const next = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      assert.deepStrictEqual(yield* api.ListQueued({ chatId: chat.id }), [])
      yield* pathBecomes(api, chat.id, [
        "you: m0",
        "model (generating)",
        "model (complete)",
        "you: m1",
        "model (generating)"
      ])
      // Its end posts nothing: nothing waited on it.
      yield* release(inserted.entry.version.id)
      yield* release(next.entry.version.id)
      yield* pathBecomes(api, chat.id, [
        "you: m0",
        "model (complete)",
        "model (complete)",
        "you: m1",
        "model (complete)"
      ])
      assert.deepStrictEqual(yield* api.ListQueued({ chatId: chat.id }), [])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  it.live("what's queued behind the reply at the tip posts there after an insertion", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, reply } = yield* generatingChat(api)
      const [m0] = yield* path(api, chat.id)
      const forkId = (yield* api.GetChat({ chatId: chat.id })).currentForkId!
      const queued = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: reply.slotId,
        branch: false,
        content: "m1"
      })
      assert.strictEqual(queued._tag, "Queued")
      yield* api.InsertMessage({
        chatId: chat.id,
        forkId,
        anchor: m0!.slotId,
        expectedRowVersion: m0!.rowVersion,
        body: { _tag: "Write", speaker: null, content: "inserted" }
      })
      assert.strictEqual((yield* api.ListQueued({ chatId: chat.id })).length, 1)
      yield* release(reply.version.id)
      const entries = yield* pathBecomes(api, chat.id, [
        "you: m0",
        "you: inserted",
        "model (complete)",
        "you: m1",
        "model (generating)"
      ])
      assert.deepStrictEqual(
        entries.map((e) => e.position),
        [0, 1, 2, 3, 4]
      )
      yield* release(entries[4]!.version.id)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )
})
