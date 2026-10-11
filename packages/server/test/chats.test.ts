// The chat RPCs over a real server, real workers and a real socket: windows of a path in
// both directions, versions with optimistic concurrency, and generations streamed as
// deltas, stopped, failed and deleted. Cross-user access is in the isolation matrix.
import { assert, describe, it } from "@effect/vitest"
import type { Chat, PathEntry, SlotId, Version, VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent, PathRange } from "@rp/shared/chatApi.ts"
import { Effect, Layer, Option, Stream } from "effect"
import * as FakeGenerator from "../src/chat/fakeGenerator.ts"
import { GenerationFailed, Generator } from "../src/chat/Generator.ts"
import { AppConfig, type AppConfigShape } from "../src/config.ts"
import { Writer } from "../src/db/Database.ts"
import { serverWith } from "../src/server.ts"
import { client, outcome, testConfig } from "./support/config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const withGenerator = (config: AppConfigShape, generator: Layer.Layer<Generator>) =>
  Effect.provide(serverWith(generator).pipe(Layer.provide(Layer.succeed(AppConfig)(config))))

const fast = FakeGenerator.layer({ tokensPerSecond: 3000, tokens: 150 })

/** Polls until `check` holds, for at most `ms`. */
const eventually = (check: () => boolean, ms = 10_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("timed out waiting"))
      yield* Effect.sleep(10)
    }
  })

/** Subscribes for the rest of the scope, collecting every event. */
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

/** The text a client would have for a version from Hello and deltas. */
const streamedText = (events: ReadonlyArray<ChatEvent>, versionId: VersionId) => {
  let text = ""
  for (const event of events) {
    if (event._tag === "Hello") text = event.live.find((l) => l.versionId === versionId)?.text ?? text
    if (event._tag === "Delta" && event.versionId === versionId) {
      assert.isAtMost(event.offset, text.length, "a gap in the deltas")
      text = text.slice(0, event.offset) + event.text
    }
  }
  return text
}

const finished = (events: ReadonlyArray<ChatEvent>, versionId: VersionId) =>
  events.flatMap((e) => (e._tag === "Version" && e.version.id === versionId ? [e.version] : [])).at(-1)

const contents = (entries: ReadonlyArray<PathEntry>) => entries.map((e) => e.version.content)

/** A chat of `count` messages "m0", "m1", …, returning their slots in order. */
const linearChat = (api: Api, count: number) =>
  Effect.gen(function* () {
    const chat = yield* api.CreateChat({ title: "Harbor" })
    const slots: Array<SlotId> = []
    let parent: SlotId | null = null
    for (let i = 0; i < count; i++) {
      const sent: { entry: PathEntry } = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: parent,
        branch: false,
        content: `m${i}`
      })
      const entry = sent.entry
      slots.push(entry.slotId)
      parent = entry.slotId
    }
    return { chat, slots }
  })

const read = (api: Api, chatId: Chat["id"], range: PathRange, limit: number, leafSlotId: SlotId | null = null) =>
  api.ReadPath({ chatId, leafSlotId, range, limit })

describe("chats", () => {
  it.live("lists chats by last message, in pages", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client(config)
      const first = yield* api.CreateChat({ title: "  First  " })
      const second = yield* api.CreateChat({ title: "Second" })
      assert.strictEqual(first.title, "First")
      yield* api.SendMessage({ chatId: first.id, parentSlotId: null, branch: false, content: "hello" })
      const all = yield* api.ListChats({ limit: 10, before: null })
      assert.deepStrictEqual(
        all.map((c) => c.id),
        [first.id, second.id]
      )
      const page = yield* api.ListChats({ limit: 1, before: null })
      const last = page[0]!
      const rest = yield* api.ListChats({
        limit: 10,
        before: { at: last.lastMessageAt ?? last.createdAt, id: last.id }
      })
      assert.deepStrictEqual(
        rest.map((c) => c.id),
        [second.id]
      )
    }).pipe(Effect.scoped, withGenerator(config, Generator.none))
  })

  it.live("a message names the tip it was written under; a branch starts anywhere", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client(config)
      const { chat, slots } = yield* linearChat(api, 3)
      assert.strictEqual(
        yield* outcome(api.SendMessage({ chatId: chat.id, parentSlotId: slots[0]!, branch: false, content: "late" })),
        "LeafMoved"
      )
      const branched = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: slots[0]!,
        branch: true,
        content: "alt"
      })
      assert.strictEqual(branched.chat.activeLeafSlotId, branched.entry.slotId)
      const path = yield* read(api, chat.id, { _tag: "Bottom" }, 10)
      assert.deepStrictEqual(contents(path.entries), ["m0", "alt"])
      const old = yield* read(api, chat.id, { _tag: "Bottom" }, 10, slots[2]!)
      assert.deepStrictEqual(contents(old.entries), ["m0", "m1", "m2"])
    }).pipe(Effect.scoped, withGenerator(config, Generator.none))
  })

  it.live("reads a path in windows, both ways, and opens at a slot", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client(config)
      const { chat, slots } = yield* linearChat(api, 30)
      // A branch below m10, and a deleted message on the main path: neither shows.
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: slots[10]!, branch: true, content: "side" })
      const leaf = slots[29]!
      yield* api.DeleteMessage({ slotId: slots[20]! })

      const bottom = yield* read(api, chat.id, { _tag: "Bottom" }, 5, leaf)
      assert.deepStrictEqual(contents(bottom.entries), ["m25", "m26", "m27", "m28", "m29"])
      assert.isNull(bottom.newer)
      const older = yield* read(api, chat.id, { _tag: "Older", from: bottom.older! }, 5, leaf)
      assert.deepStrictEqual(contents(older.entries), ["m21", "m22", "m23", "m24"]) // m20 is deleted

      const around = yield* read(api, chat.id, { _tag: "Around", slot: slots[5]! }, 6, leaf)
      assert.deepStrictEqual(contents(around.entries), ["m3", "m4", "m5", "m6", "m7", "m8"])
      assert.strictEqual(around.leafSlotId, leaf)
      // Paging down crosses the branch point at m10 and the deleted m20, and ends at the leaf.
      const seen = [...contents(around.entries)]
      let newer = around.newer
      while (newer !== null) {
        const page = yield* read(api, chat.id, { _tag: "Newer", after: newer }, 4, leaf)
        seen.push(...contents(page.entries))
        newer = page.newer
      }
      assert.deepStrictEqual(
        seen,
        Array.from({ length: 27 }, (_, i) => `m${i + 3}`).filter((m) => m !== "m20")
      )
      const top = yield* read(api, chat.id, { _tag: "Around", slot: slots[0]! }, 6, leaf)
      assert.deepStrictEqual(contents(top.entries), ["m0", "m1", "m2", "m3", "m4", "m5"])
      assert.isNull(top.older)
    }).pipe(Effect.scoped, withGenerator(config, Generator.none))
  })

  it.live("a slot that isn't on the path opens the path through it, on its latest replies", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client(config)
      const { chat, slots } = yield* linearChat(api, 4)
      const side = yield* api.SendMessage({ chatId: chat.id, parentSlotId: slots[1]!, branch: true, content: "side" })
      const tip = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: side.entry.slotId,
        branch: false,
        content: "side 2"
      })
      // Back on the main path, the active leaf is m3 again.
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: slots[3]!, branch: true, content: "m4" })
      const window = yield* read(api, chat.id, { _tag: "Around", slot: side.entry.slotId }, 10)
      assert.strictEqual(window.leafSlotId, tip.entry.slotId)
      assert.deepStrictEqual(contents(window.entries), ["m0", "m1", "side", "side 2"])
    }).pipe(Effect.scoped, withGenerator(config, Generator.none))
  })

  it.live("the path through a slot on another branch goes through a message deleted on its own", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client(config)
      const { chat, slots } = yield* linearChat(api, 2)
      let parent = slots[0]!
      const side: Array<SlotId> = []
      for (const content of ["b1", "b2", "b3"]) {
        const sent = yield* api.SendMessage({ chatId: chat.id, parentSlotId: parent, branch: true, content })
        parent = sent.entry.slotId
        side.push(parent)
      }
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: slots[1]!, branch: true, content: "m2" })
      const item = yield* api.DeleteMessage({ slotId: side[1]! })
      const window = yield* read(api, chat.id, { _tag: "Around", slot: side[0]! }, 10)
      assert.strictEqual(window.leafSlotId, side[2])
      assert.deepStrictEqual(contents(window.entries), ["m0", "b1", "b3"])
      // Still, once it's deleted for good.
      const writer = yield* Writer
      const me = yield* api.Whoami()
      yield* writer.PurgeBinItem({ userId: me.id, itemId: item.id })
      const purged = yield* read(api, chat.id, { _tag: "Around", slot: side[0]! }, 10)
      assert.deepStrictEqual(contents(purged.entries), ["m0", "b1", "b3"])
    }).pipe(Effect.scoped, withGenerator(config, Generator.none))
  })

  it.live("a caller going away can't leave a version generating with nothing behind it", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client(config)
      const { chat, slots } = yield* linearChat(api, 1)
      const { entry } = yield* api.Generate({ chatId: chat.id, parentSlotId: slots[0]!, branch: false })
      for (let i = 0; i < 24; i++) {
        const [current] = (yield* read(api, chat.id, { _tag: "Bottom" }, 1)).entries
        yield* api
          .Regenerate({ slotId: entry.slotId, expectedRowVersion: current!.rowVersion })
          .pipe(Effect.timeoutOption(i % 6))
      }
      const versions = yield* Effect.gen(function* () {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const list = yield* api.ListVersions({ slotId: entry.slotId })
          if (list.every((v) => v.status !== "generating")) return list
          yield* Effect.sleep(100)
        }
        return yield* api.ListVersions({ slotId: entry.slotId })
      })
      assert.deepStrictEqual(
        versions.filter((v) => v.status === "generating").map((v) => v.id),
        []
      )
    }).pipe(Effect.scoped, withGenerator(config, fast))
  })

  it.live("a delete whose caller goes away still stops what it deleted", () => {
    const config = testConfig()
    const slow = FakeGenerator.layer({ tokensPerSecond: 100, tokens: 5000 })
    return Effect.gen(function* () {
      const api = yield* client(config)
      const { chat, slots } = yield* linearChat(api, 1)
      const events = yield* subscribe(api, chat.id)
      const { entry } = yield* api.Generate({ chatId: chat.id, parentSlotId: slots[0]!, branch: false })
      let deleted = 0
      for (let wait = 0; wait < 8; wait++) {
        const [current] = (yield* read(api, chat.id, { _tag: "Bottom" }, 1)).entries
        const swipe = yield* api.Regenerate({ slotId: entry.slotId, expectedRowVersion: current!.rowVersion })
        yield* api.DeleteVersion({ versionId: swipe.version.id }).pipe(Effect.timeoutOption(wait))
        yield* Effect.sleep(200)
        const live = (yield* api.ListVersions({ slotId: entry.slotId })).map((v) => v.id)
        if (live.includes(swipe.version.id)) continue
        // Deleted, whether or not the caller waited for the reply: so it's stopped.
        deleted++
        yield* eventually(() => finished(events, swipe.version.id) !== undefined)
        assert.strictEqual(finished(events, swipe.version.id)!.status, "stopped")
      }
      assert.isAbove(deleted, 0)
    }).pipe(Effect.scoped, withGenerator(config, slow))
  })

  it.live("versions: swipes, edits and amends check the row version", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client(config)
      const { slots } = yield* linearChat(api, 1)
      const slotId = slots[0]!
      const [original] = yield* api.ListVersions({ slotId })
      const written = yield* api.WriteVersion({ slotId, content: "mine", expectedRowVersion: 1 })
      assert.strictEqual(written.version.content, "mine")
      assert.strictEqual(written.versionCount, 2)
      assert.strictEqual(
        yield* outcome(api.WriteVersion({ slotId, content: "stale", expectedRowVersion: 1 })),
        "StaleWrite"
      )
      const selected = yield* api.SelectVersion({
        slotId,
        versionId: original!.id,
        expectedRowVersion: written.rowVersion
      })
      assert.strictEqual(selected.version.id, original!.id)
      const edited = yield* api.EditVersion({
        slotId,
        sourceVersionId: original!.id,
        content: "m0, edited",
        expectedRowVersion: selected.rowVersion
      })
      assert.strictEqual(edited.version.origin, "edited")
      assert.strictEqual(edited.version.sourceVersionId, original!.id)

      const amended = yield* api.AmendVersion({ versionId: edited.version.id, content: "again", expectedRowVersion: 1 })
      assert.strictEqual(amended.rowVersion, 2)
      assert.strictEqual(
        yield* outcome(api.AmendVersion({ versionId: edited.version.id, content: "stale", expectedRowVersion: 1 })),
        "StaleWrite"
      )
      const versions = yield* api.ListVersions({ slotId })
      assert.deepStrictEqual(
        versions.map((v) => v.content),
        ["m0", "mine", "again"]
      )
    }).pipe(Effect.scoped, withGenerator(config, Generator.none))
  })

  it.live("without a generator, generating is refused and creates nothing", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client(config)
      const { chat, slots } = yield* linearChat(api, 1)
      assert.strictEqual(
        yield* outcome(api.Generate({ chatId: chat.id, parentSlotId: slots[0]!, branch: false })),
        "GenerationUnavailable"
      )
      assert.strictEqual(
        yield* outcome(api.Regenerate({ slotId: slots[0]!, expectedRowVersion: 1 })),
        "GenerationUnavailable"
      )
      assert.strictEqual((yield* api.ListVersions({ slotId: slots[0]! })).length, 1)
      assert.strictEqual((yield* read(api, chat.id, { _tag: "Bottom" }, 10)).entries.length, 1)
    }).pipe(Effect.scoped, withGenerator(config, Generator.none))
  })

  it.live("a generation streams as deltas that add up to the saved text", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client(config)
      const { chat, slots } = yield* linearChat(api, 1)
      const events = yield* subscribe(api, chat.id)
      const { entry } = yield* api.Generate({ chatId: chat.id, parentSlotId: slots[0]!, branch: false })
      assert.strictEqual(entry.version.status, "generating")
      const id = entry.version.id
      yield* eventually(() => finished(events, id) !== undefined)
      const version = finished(events, id)!
      assert.strictEqual(version.status, "complete")
      assert.isAbove(version.content.length, 100)
      assert.strictEqual(streamedText(events, id), version.content)
      const deltas = events.filter((e) => e._tag === "Delta")
      assert.isBelow(deltas.length, 150, "deltas are coalesced, not one per token")
      const path = yield* read(api, chat.id, { _tag: "Bottom" }, 10)
      assert.strictEqual(path.entries.at(-1)!.version.content, version.content)
    }).pipe(Effect.scoped, withGenerator(config, fast))
  })

  it.live("parallel swipes under one slot stop one at a time; a late subscriber gets the text so far", () => {
    const config = testConfig()
    const slow = FakeGenerator.layer({ tokensPerSecond: 200, tokens: 2000 })
    return Effect.gen(function* () {
      const api = yield* client(config)
      const { chat, slots } = yield* linearChat(api, 1)
      const { entry } = yield* api.Generate({ chatId: chat.id, parentSlotId: slots[0]!, branch: false })
      const swipe1 = yield* api.Regenerate({ slotId: entry.slotId, expectedRowVersion: entry.rowVersion })
      assert.strictEqual(
        yield* outcome(api.Regenerate({ slotId: entry.slotId, expectedRowVersion: entry.rowVersion })),
        "StaleWrite"
      )
      const swipe2 = yield* api.Regenerate({ slotId: entry.slotId, expectedRowVersion: swipe1.rowVersion })
      const ids = [entry.version.id, swipe1.version.id, swipe2.version.id]
      yield* Effect.sleep(400)
      const events = yield* subscribe(api, chat.id)
      const hello = events[0]!
      assert.strictEqual(hello._tag, "Hello")
      assert.sameMembers(hello._tag === "Hello" ? hello.live.map((l) => l.versionId) : [], ids)

      const stopped = yield* api.StopGeneration({ versionId: swipe1.version.id })
      assert.strictEqual(stopped.status, "stopped")
      assert.isAbove(stopped.content.length, 0)
      assert.strictEqual(yield* outcome(api.StopGeneration({ versionId: swipe1.version.id })), "NotFound")
      yield* Effect.sleep(200)
      assert.strictEqual(streamedText(events, swipe1.version.id), stopped.content)
      // The others are still going.
      const versions = yield* api.ListVersions({ slotId: entry.slotId })
      assert.deepStrictEqual(
        versions.map((v) => v.status),
        ["generating", "stopped", "generating"]
      )
      // Deleting a generating swipe stops it; deleting the chat stops the rest.
      yield* api.DeleteVersion({ versionId: swipe2.version.id })
      yield* eventually(() => finished(events, swipe2.version.id) !== undefined)
      assert.strictEqual(finished(events, swipe2.version.id)!.status, "stopped")
      yield* api.DeleteChat({ chatId: chat.id })
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      assert.strictEqual(finished(events, entry.version.id)!.status, "stopped")
    }).pipe(Effect.scoped, withGenerator(config, slow))
  })

  it.live("a failed generation becomes a failed version with its cause and its text so far", () => {
    const config = testConfig()
    const failing = Layer.succeed(Generator)(
      Option.some({
        generate: () =>
          Stream.concat(
            Stream.make("The first ", "words "),
            Stream.fail(new GenerationFailed({ class: "context_overflow", message: "too long" }))
          )
      })
    )
    return Effect.gen(function* () {
      const api = yield* client(config)
      const { chat, slots } = yield* linearChat(api, 1)
      const events = yield* subscribe(api, chat.id)
      const { entry } = yield* api.Generate({ chatId: chat.id, parentSlotId: slots[0]!, branch: false })
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      const version: Version = finished(events, entry.version.id)!
      assert.strictEqual(version.status, "failed")
      assert.deepStrictEqual(version.error, { class: "context_overflow", message: "too long" })
      assert.strictEqual(version.content, "The first words ")
      const path = yield* read(api, chat.id, { _tag: "Bottom" }, 10)
      assert.isFalse(path.entries.at(-1)!.inContext)
    }).pipe(Effect.scoped, withGenerator(config, failing))
  })

  it.live("a server stopping mid-generation keeps the text as interrupted", () => {
    const config = testConfig()
    const slow = FakeGenerator.layer({ tokensPerSecond: 100, tokens: 5000 })
    const stopped = Effect.gen(function* () {
      const api = yield* client(config)
      const { chat, slots } = yield* linearChat(api, 1)
      const { entry } = yield* api.Generate({ chatId: chat.id, parentSlotId: slots[0]!, branch: false })
      yield* Effect.sleep(300)
      return { chatId: chat.id, versionId: entry.version.id }
    }).pipe(Effect.scoped, withGenerator(config, slow))
    const restarted = (started: Effect.Success<typeof stopped>) =>
      Effect.gen(function* () {
        const api = yield* client(config)
        const path = yield* read(api, started.chatId, { _tag: "Bottom" }, 10)
        const version = path.entries.at(-1)!.version
        assert.strictEqual(version.id, started.versionId)
        assert.strictEqual(version.status, "interrupted")
        assert.isAbove(version.content.length, 0)
      }).pipe(Effect.scoped, withGenerator(config, Generator.none))
    return Effect.flatMap(stopped, restarted)
  })

  it.live(
    "six streams at 300 tokens a second leave the event loop free",
    () => {
      const config = testConfig()
      const harness = FakeGenerator.layer({ tokensPerSecond: 300, tokens: 900 })
      return Effect.gen(function* () {
        const api = yield* client(config)
        const chats = yield* Effect.forEach([0, 1, 2], () => linearChat(api, 1))
        const events = yield* Effect.forEach(chats, ({ chat }) => subscribe(api, chat.id))
        // The server runs in this process: a 10 ms timer here sees every stall of its loop
        // while the streams run, without the startup the Health window would include.
        const delays: Array<number> = []
        let last = performance.now()
        const timer = setInterval(() => {
          const now = performance.now()
          delays.push(now - last - 10)
          last = now
        }, 10)
        for (const { chat, slots } of chats) {
          const { entry } = yield* api.Generate({ chatId: chat.id, parentSlotId: slots[0]!, branch: false })
          yield* api.Regenerate({ slotId: entry.slotId, expectedRowVersion: entry.rowVersion })
        }
        yield* eventually(() => events.every((list) => list.filter((e) => e._tag === "Version").length === 2), 20_000)
        clearInterval(timer)
        delays.sort((a, b) => a - b)
        const p99 = delays[Math.floor(delays.length * 0.99)]!
        const max = delays.at(-1)!
        // Measured at load 80 on the 48-core host: p99 45 to 53 ms, idle 8 ms. This process
        // also runs the clients, which decode every batch the browser would.
        assert.isBelow(p99, 80, `event loop delay p99 ${p99.toFixed(1)} ms`)
        assert.isBelow(max, 250, `event loop delay max ${max.toFixed(1)} ms`)
      }).pipe(Effect.scoped, withGenerator(config, harness))
    },
    60_000
  )
})
