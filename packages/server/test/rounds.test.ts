// A round of replies (DESIGN §2.3): a Generate or a queued send names who replies after its
// reply, and the server queues them behind it, each posting when the one before ends. Stop (or a
// failed reply) holds the rest for Continue round; any turn added at the fork's tip ends it.
// The generator here only ends when the test says so, so every ordering is the test's.
import { assert, describe, it } from "@effect/vitest"
import type { Chat, EntityId, PathEntry, VersionId } from "@rp/shared/chat.ts"
import { Deferred, Effect, Layer, Option, Stream } from "effect"
import { Writer } from "../src/db/Database.ts"
import { GenerationFailed, Generator } from "../src/chat/Generator.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const gates = new Map<string, Deferred.Deferred<void, GenerationFailed>>()
const gated = Layer.succeed(Generator)(
  Option.some({
    generate: (request) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void, GenerationFailed>()
          gates.set(request.versionId, gate)
          return Stream.concat(
            Stream.make("A line. "),
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

/** A chat with three cards and a user message. */
const setup = (api: Api) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const user = yield* api.Whoami()
    const names = new Map<string, string>()
    const make = (label: string) =>
      Effect.map(
        writer.CreateEntity({
          userId: user.id,
          kind: "card",
          label,
          subtitle: "",
          doc: cardDoc(label),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        }),
        (card) => {
          names.set(card.entityId, label)
          return card.entityId
        }
      )
    const [mira, tobin, wren] = [yield* make("Mira"), yield* make("Tobin"), yield* make("Wren")]
    const chat = yield* api.CreateChat({ title: "Round" })
    const sent = yield* posted(api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "m0" }))
    const describe = (e: PathEntry) =>
      e.version.writer === "human"
        ? `you: ${e.version.content}`
        : `${names.get(e.version.speakerEntityId ?? "") ?? "?"} (${e.version.status})`
    return { chat, sent: sent.entry, mira, tobin, wren, describe }
  })

const pathBecomes = (
  api: Api,
  chatId: Chat["id"],
  describe: (e: PathEntry) => string,
  expected: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000
    while (true) {
      const window = yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 50 })
      const shown = window.entries.map(describe)
      if (JSON.stringify(shown) === JSON.stringify(expected)) return window.entries
      if (Date.now() > deadline) assert.deepStrictEqual(shown, expected)
      yield* Effect.sleep(20)
    }
  })

const roundOf = (api: Api, chatId: Chat["id"]) =>
  Effect.map(api.ListQueued({ chatId }), (queue) =>
    queue.filter((q) => q.round !== undefined).map((q) => ({ speaker: q.speakerEntityId, held: q.round!.held }))
  )

describe("rounds", () => {
  it.live("a queued round recovered at startup gets a start when its remaining replies continue", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, sent, mira, tobin, wren, describe } = yield* setup(api)
      const first = yield* posted(
        api.Generate({ chatId: chat.id, parentSlotId: sent.slotId, branch: false, speakerEntityId: mira })
      )
      yield* gate(first.entry.version.id)
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: first.entry.slotId,
        branch: false,
        content: "Recovered without a reply.",
        replySpeakerEntityId: tobin,
        round: [wren, mira],
        autoPick: true
      })
      yield* (yield* Writer).InterruptGenerations()
      const held = (yield* api.ListQueued({ chatId: chat.id })).filter((q) => q.round)
      assert.lengthOf(held, 2)
      assert.isTrue(held.every((q) => q.round!.held && q.round!.startSlotId === undefined))
      yield* api.Round({ chatId: chat.id, forkId: null, action: "continue" })
      const resumed = yield* pathBecomes(api, chat.id, describe, [
        "you: m0",
        "Mira (interrupted)",
        "you: Recovered without a reply.",
        "Wren (generating)"
      ])
      const remaining = (yield* api.ListQueued({ chatId: chat.id })).filter((q) => q.round)
      assert.lengthOf(remaining, 1)
      assert.strictEqual(remaining[0]!.round!.startSlotId, resumed[3]!.slotId)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  it.live("a queued round starts at its own first reply, after earlier queued actions", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, sent, mira, tobin, wren, describe } = yield* setup(api)
      const first = yield* posted(
        api.Generate({ chatId: chat.id, parentSlotId: sent.slotId, branch: false, speakerEntityId: mira })
      )
      yield* api.Generate({
        chatId: chat.id,
        parentSlotId: first.entry.slotId,
        branch: false,
        speakerEntityId: tobin
      })
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: first.entry.slotId,
        branch: false,
        content: "Start my round here.",
        replySpeakerEntityId: wren,
        round: [mira, tobin],
        autoPick: true
      })
      yield* release(first.entry.version.id)
      const earlier = yield* pathBecomes(api, chat.id, describe, ["you: m0", "Mira (complete)", "Tobin (generating)"])
      let round = (yield* api.ListQueued({ chatId: chat.id })).filter((q) => q.round)
      assert.lengthOf(round, 2)
      assert.isTrue(round.every((q) => q.round!.decides))
      assert.isTrue(
        round.every((q) => q.round!.startSlotId === undefined),
        "the round has not started yet"
      )
      yield* release(earlier[2]!.version.id)
      const started = yield* pathBecomes(api, chat.id, describe, [
        "you: m0",
        "Mira (complete)",
        "Tobin (complete)",
        "you: Start my round here.",
        "Wren (generating)"
      ])
      round = (yield* api.ListQueued({ chatId: chat.id })).filter((q) => q.round)
      assert.isTrue(round.every((q) => q.round!.startSlotId === started[4]!.slotId))
      yield* release(started[4]!.version.id)
      yield* pathBecomes(api, chat.id, describe, [
        "you: m0",
        "Mira (complete)",
        "Tobin (complete)",
        "you: Start my round here.",
        "Wren (complete)",
        "Mira (generating)"
      ])
      round = (yield* api.ListQueued({ chatId: chat.id })).filter((q) => q.round)
      assert.lengthOf(round, 1)
      assert.strictEqual(round[0]!.round!.startSlotId, started[4]!.slotId)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  for (const stopped of [false, true]) {
    it.live(`swiping the ${stopped ? "stopped" : "running"} reply preserves the round's hold state`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const { chat, sent, mira, tobin, describe } = yield* setup(api)
        const first = yield* posted(
          api.Generate({
            chatId: chat.id,
            parentSlotId: sent.slotId,
            branch: false,
            speakerEntityId: mira,
            round: [tobin]
          })
        )
        yield* gate(first.entry.version.id)
        if (stopped) yield* api.StopGeneration({ versionId: first.entry.version.id })
        const entries = yield* pathBecomes(api, chat.id, describe, [
          "you: m0",
          `Mira (${stopped ? "stopped" : "generating"})`
        ])
        const swipe = yield* api.Regenerate({ slotId: first.entry.slotId, expectedRowVersion: entries[1]!.rowVersion })
        if (!stopped) {
          yield* release(first.entry.version.id)
          // Drain only after the selected swipe finishes, even when the old version ends first.
          yield* Effect.sleep(100)
          assert.deepStrictEqual(yield* roundOf(api, chat.id), [{ speaker: tobin, held: false }])
          yield* pathBecomes(api, chat.id, describe, ["you: m0", "Mira (generating)"])
        }
        yield* release(swipe.version.id)
        if (stopped) {
          yield* pathBecomes(api, chat.id, describe, ["you: m0", "Mira (complete)"])
          assert.deepStrictEqual(yield* roundOf(api, chat.id), [{ speaker: tobin, held: true }])
          yield* api.Round({ chatId: chat.id, forkId: null, action: "continue" })
        }
        yield* pathBecomes(api, chat.id, describe, ["you: m0", "Mira (complete)", "Tobin (generating)"])
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
    )
  }

  for (const ending of ["stopped", "failed"] as const) {
    it.live(`a ${ending} old reply does not pause the replacement send's round`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const { chat, sent, mira, tobin, wren, describe } = yield* setup(api)
        const first = yield* posted(
          api.Generate({
            chatId: chat.id,
            parentSlotId: sent.slotId,
            branch: false,
            speakerEntityId: mira,
            round: [tobin]
          })
        )
        yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: first.entry.slotId,
          branch: false,
          content: "m1",
          replySpeakerEntityId: wren,
          round: [tobin]
        })
        yield* gate(first.entry.version.id)
        if (ending === "stopped") yield* api.StopGeneration({ versionId: first.entry.version.id })
        else yield* failWith(first.entry.version.id)
        const entries = yield* pathBecomes(api, chat.id, describe, [
          "you: m0",
          `Mira (${ending})`,
          "you: m1",
          "Wren (generating)"
        ])
        assert.deepStrictEqual(yield* roundOf(api, chat.id), [{ speaker: tobin, held: false }])
        yield* release(entries[3]!.version.id)
        yield* pathBecomes(api, chat.id, describe, [
          "you: m0",
          `Mira (${ending})`,
          "you: m1",
          "Wren (complete)",
          "Tobin (generating)"
        ])
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
    )
  }

  for (const kind of ["message", "generate"] as const) {
    it.live(`withdrawing a queued ${kind} cancels its round without touching another queued action`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const { chat, sent, mira, tobin, wren, describe } = yield* setup(api)
        const first = yield* posted(
          api.Generate({ chatId: chat.id, parentSlotId: sent.slotId, branch: false, speakerEntityId: mira })
        )
        const queued = yield* kind === "message"
          ? api.SendMessage({
              chatId: chat.id,
              parentSlotId: first.entry.slotId,
              branch: false,
              content: "withdraw me",
              replySpeakerEntityId: tobin,
              round: [wren]
            })
          : api.Generate({
              chatId: chat.id,
              parentSlotId: first.entry.slotId,
              branch: false,
              speakerEntityId: tobin,
              round: [wren]
            })
        if (queued._tag !== "Queued") return assert.fail("expected a queued action")
        yield* api.WithdrawQueued({ queuedId: queued.queued.id, expectedRowVersion: queued.queued.rowVersion })
        assert.deepStrictEqual(yield* api.ListQueued({ chatId: chat.id }), [])
        // A later action has its own round: withdrawing an earlier action must keep that one.
        const earlier = yield* api.Generate({
          chatId: chat.id,
          parentSlotId: first.entry.slotId,
          branch: false,
          speakerEntityId: tobin
        })
        if (earlier._tag !== "Queued") return assert.fail("expected an earlier queued action")
        yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: first.entry.slotId,
          branch: false,
          content: "keep me",
          replySpeakerEntityId: tobin,
          round: [wren]
        })
        yield* api.WithdrawQueued({ queuedId: earlier.queued.id, expectedRowVersion: earlier.queued.rowVersion })
        assert.deepStrictEqual(yield* roundOf(api, chat.id), [{ speaker: wren, held: false }])
        yield* release(first.entry.version.id)
        const entries = yield* pathBecomes(api, chat.id, describe, [
          "you: m0",
          "Mira (complete)",
          "you: keep me",
          "Tobin (generating)"
        ])
        yield* release(entries[3]!.version.id)
        yield* pathBecomes(api, chat.id, describe, [
          "you: m0",
          "Mira (complete)",
          "you: keep me",
          "Tobin (complete)",
          "Wren (generating)"
        ])
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
    )
  }

  it.live("a new message ending a held round publishes the empty queue to other tabs", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, sent, mira, tobin, describe } = yield* setup(api)
      const events: Array<import("@rp/shared/chatApi.ts").ChatEvent> = []
      yield* api.SubscribeChat({ chatId: chat.id }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
        Effect.forkScoped
      )
      yield* eventually(() => events.length > 0)
      const first = yield* posted(
        api.Generate({
          chatId: chat.id,
          parentSlotId: sent.slotId,
          branch: false,
          speakerEntityId: mira,
          round: [tobin]
        })
      )
      yield* gate(first.entry.version.id)
      yield* api.StopGeneration({ versionId: first.entry.version.id })
      yield* pathBecomes(api, chat.id, describe, ["you: m0", "Mira (stopped)"])
      yield* eventually(() => events.some((e) => e._tag === "Queue" && e.queue.some((q) => q.round?.held)))
      yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: first.entry.slotId,
          branch: false,
          content: "No reply this time",
          reply: false
        })
      )
      assert.deepStrictEqual(yield* api.ListQueued({ chatId: chat.id }), [])
      yield* eventually(() => events.some((e) => e._tag === "Queue" && e.queue.length === 0), 1000)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  it.live("a second tab continuing an already running round receives the current queue", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, sent, mira, tobin, wren, describe } = yield* setup(api)
      const first = yield* posted(
        api.Generate({
          chatId: chat.id,
          parentSlotId: sent.slotId,
          branch: false,
          speakerEntityId: mira,
          round: [tobin, wren]
        })
      )
      yield* gate(first.entry.version.id)
      yield* api.StopGeneration({ versionId: first.entry.version.id })
      yield* pathBecomes(api, chat.id, describe, ["you: m0", "Mira (stopped)"])
      const firstContinue = yield* api.Round({ chatId: chat.id, forkId: null, action: "continue" })
      const secondContinue = yield* api.Round({ chatId: chat.id, forkId: null, action: "continue" })
      assert.deepStrictEqual(secondContinue, firstContinue)
      assert.deepStrictEqual(secondContinue, yield* api.ListQueued({ chatId: chat.id }))
      yield* pathBecomes(api, chat.id, describe, ["you: m0", "Mira (stopped)", "Tobin (generating)"])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  it.live("each reply of a round posts when the one before ends", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, sent, mira, tobin, wren, describe } = yield* setup(api)
      const first = yield* posted(
        api.Generate({
          chatId: chat.id,
          parentSlotId: sent.slotId,
          branch: false,
          speakerEntityId: mira,
          round: [tobin, wren]
        })
      )
      assert.deepStrictEqual(yield* roundOf(api, chat.id), [
        { speaker: tobin, held: false },
        { speaker: wren, held: false }
      ])
      yield* release(first.entry.version.id)
      let entries = yield* pathBecomes(api, chat.id, describe, ["you: m0", "Mira (complete)", "Tobin (generating)"])
      assert.deepStrictEqual(yield* roundOf(api, chat.id), [{ speaker: wren, held: false }])
      yield* release(entries[2]!.version.id)
      entries = yield* pathBecomes(api, chat.id, describe, [
        "you: m0",
        "Mira (complete)",
        "Tobin (complete)",
        "Wren (generating)"
      ])
      assert.deepStrictEqual(yield* roundOf(api, chat.id), [])
      yield* release(entries[3]!.version.id)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  for (const ending of ["stopped", "failed"] as const) {
    it.live(`a ${ending} reply holds the rest of the round until Continue round, at the tip as it is then`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const { chat, sent, mira, tobin, wren, describe } = yield* setup(api)
        const first = yield* posted(
          api.Generate({
            chatId: chat.id,
            parentSlotId: sent.slotId,
            branch: false,
            speakerEntityId: mira,
            round: [tobin, wren]
          })
        )
        yield* gate(first.entry.version.id)
        if (ending === "stopped") yield* api.StopGeneration({ versionId: first.entry.version.id })
        else yield* failWith(first.entry.version.id)
        yield* pathBecomes(api, chat.id, describe, ["you: m0", `Mira (${ending})`])
        assert.deepStrictEqual(yield* roundOf(api, chat.id), [
          { speaker: tobin, held: true },
          { speaker: wren, held: true }
        ])
        // Nothing posts on its own; an edit of the stopped reply leaves the round held.
        yield* Effect.sleep(100)
        yield* pathBecomes(api, chat.id, describe, ["you: m0", `Mira (${ending})`])
        const queue = yield* api.Round({ chatId: chat.id, forkId: null, action: "continue" })
        assert.deepStrictEqual(
          queue.filter((q) => q.round).map((q) => [q.speakerEntityId, q.round!.held]),
          [[wren, false]]
        )
        const entries = yield* pathBecomes(api, chat.id, describe, [
          "you: m0",
          `Mira (${ending})`,
          "Tobin (generating)"
        ])
        yield* release(entries[2]!.version.id)
        const after = yield* pathBecomes(api, chat.id, describe, [
          "you: m0",
          `Mira (${ending})`,
          "Tobin (complete)",
          "Wren (generating)"
        ])
        yield* release(after[3]!.version.id)
        // Nothing held: continuing again changes nothing.
        yield* pathBecomes(api, chat.id, describe, [
          "you: m0",
          `Mira (${ending})`,
          "Tobin (complete)",
          "Wren (complete)"
        ])
        yield* api.Round({ chatId: chat.id, forkId: null, action: "continue" })
        assert.deepStrictEqual(yield* roundOf(api, chat.id), [])
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
    )
  }

  it.live("End round drops the rest; the reply being written goes on", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, sent, mira, tobin, wren, describe } = yield* setup(api)
      const first = yield* posted(
        api.Generate({
          chatId: chat.id,
          parentSlotId: sent.slotId,
          branch: false,
          speakerEntityId: mira,
          round: [tobin, wren]
        })
      )
      yield* api.Round({ chatId: chat.id, forkId: null, action: "end" })
      assert.deepStrictEqual(yield* roundOf(api, chat.id), [])
      yield* release(first.entry.version.id)
      yield* pathBecomes(api, chat.id, describe, ["you: m0", "Mira (complete)"])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  it.live("a send queued mid-round replaces the rest of it with its own round", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, sent, mira, tobin, wren, describe } = yield* setup(api)
      const first = yield* posted(
        api.Generate({
          chatId: chat.id,
          parentSlotId: sent.slotId,
          branch: false,
          speakerEntityId: mira,
          round: [tobin, wren]
        })
      )
      const queued = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: first.entry.slotId,
        branch: false,
        content: "m1",
        replySpeakerEntityId: wren,
        round: [mira]
      })
      assert.strictEqual(queued._tag, "Queued")
      assert.deepStrictEqual(yield* roundOf(api, chat.id), [{ speaker: mira, held: false }])
      yield* release(first.entry.version.id)
      const entries = yield* pathBecomes(api, chat.id, describe, [
        "you: m0",
        "Mira (complete)",
        "you: m1",
        "Wren (generating)"
      ])
      yield* release(entries[3]!.version.id)
      const after = yield* pathBecomes(api, chat.id, describe, [
        "you: m0",
        "Mira (complete)",
        "you: m1",
        "Wren (complete)",
        "Mira (generating)"
      ])
      yield* release(after[4]!.version.id)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  it.live("a stopped round ends with the next message sent at the tip", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, sent, mira, tobin, describe } = yield* setup(api)
      const first = yield* posted(
        api.Generate({
          chatId: chat.id,
          parentSlotId: sent.slotId,
          branch: false,
          speakerEntityId: mira,
          round: [tobin]
        })
      )
      yield* gate(first.entry.version.id)
      yield* api.StopGeneration({ versionId: first.entry.version.id })
      yield* pathBecomes(api, chat.id, describe, ["you: m0", "Mira (stopped)"])
      assert.deepStrictEqual(yield* roundOf(api, chat.id), [{ speaker: tobin, held: true }])
      yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: first.entry.slotId, branch: false, content: "m1" })
      )
      assert.deepStrictEqual(yield* roundOf(api, chat.id), [])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )

  it.live("a restart holds a round rather than dropping it", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const { chat, sent, mira, tobin } = yield* setup(api)
      yield* posted(
        api.Generate({
          chatId: chat.id,
          parentSlotId: sent.slotId,
          branch: false,
          speakerEntityId: mira,
          round: [tobin]
        })
      )
      yield* writer.InterruptGenerations()
      assert.deepStrictEqual(yield* roundOf(api, chat.id), [{ speaker: tobin as EntityId, held: true }])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), gated)))
  )
})
