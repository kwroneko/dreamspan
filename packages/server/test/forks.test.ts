// Forks as rows (spec/FORK-INDEPENDENCE-DELTA.md §2.1, implementation unit 2): each has its
// own tip, which appending moves; the current fork is the one last chatted in or made by
// forking (UX-REWORK §3); a send names its fork and must be at its tip. Cross-user access is
// in the isolation matrix; the migration is in forkMigration.test.ts.
import { DatabaseSync } from "node:sqlite"
import { assert, describe, it } from "@effect/vitest"
import type { ChatId, ForkId, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import { client, outcome, posted, testConfig, typeInto, withServer } from "./support/config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const send = (api: Api, chatId: ChatId, forkId: ForkId | null, parentSlotId: SlotId | null, content: string) =>
  Effect.map(posted(api.SendMessage({ chatId, forkId, parentSlotId, branch: false, content })), (sent) => ({
    slotId: sent.entry.slotId,
    chat: sent.chat
  }))

const texts = (api: Api, chatId: ChatId, forkId: ForkId | null) =>
  Effect.map(api.ReadPath({ chatId, forkId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 }), (window) =>
    window.entries.map((e) => e.version.content)
  )

const current = (api: Api, chatId: ChatId) => Effect.map(api.GetChat({ chatId }), (chat) => chat.currentForkId)

describe("forks", () => {
  it.live("a new chat has one fork, with the chat's id, current, and no tip before its first message", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "First" })
      assert.strictEqual(chat.currentForkId, chat.id as string as ForkId)
      const [fork] = yield* api.ListForks({ chatId: chat.id })
      assert.deepStrictEqual(
        [fork!.id, fork!.parentForkId, fork!.baseSlotId, fork!.tipSlotId, fork!.current],
        [chat.currentForkId, null, null, null, true]
      )
      const first = yield* send(api, chat.id, null, null, "hello")
      const [after] = yield* api.ListForks({ chatId: chat.id })
      assert.deepStrictEqual([after!.tipSlotId, after!.tipExcerpt], [first.slotId, "hello"])
      assert.isNotNull(after!.lastChattedAt)
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("the current fork is the one last chatted in or made by forking, and a deleted one is replaced", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Current" })
      const main = chat.currentForkId!
      const m0 = yield* send(api, chat.id, null, null, "m0")
      const m1 = yield* send(api, chat.id, null, m0.slotId, "m1")
      // Made by forking: current.
      const made = yield* api.CreateFork({ chatId: chat.id, fromForkId: main, atSlotId: m0.slotId })
      assert.strictEqual(made.chat.currentForkId, made.fork.id)
      assert.deepStrictEqual(
        [made.fork.parentForkId, made.fork.baseSlotId, made.fork.tipSlotId],
        [main, m0.slotId, m0.slotId]
      )
      // The chat opens on it: its path is the history up to where it was made.
      assert.deepStrictEqual(yield* texts(api, chat.id, null), ["m0"])
      // Chatted in: current again.
      yield* send(api, chat.id, main, m1.slotId, "m2")
      assert.strictEqual(yield* current(api, chat.id), main)
      const b = yield* send(api, chat.id, made.fork.id, m0.slotId, "b1")
      assert.strictEqual(b.chat.currentForkId, made.fork.id)
      assert.deepStrictEqual(yield* texts(api, chat.id, null), ["m0", "b1"])
      assert.deepStrictEqual(yield* texts(api, chat.id, main), ["m0", "m1", "m2"])
      // Its branch deleted, the current fork goes with it: the most recently current live
      // one opens instead.
      yield* api.DeleteBranch({ slotId: b.slotId })
      assert.strictEqual(yield* current(api, chat.id), main)
      assert.deepStrictEqual(
        (yield* api.ListForks({ chatId: chat.id })).map((f) => f.id),
        [main]
      )
      assert.strictEqual(
        yield* outcome(
          api.ReadPath({ chatId: chat.id, forkId: made.fork.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 9 })
        ),
        "NotFound"
      )
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("a send names its fork and must be at its tip, whichever fork is current", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Tips" })
      const main = chat.currentForkId!
      const m0 = yield* send(api, chat.id, null, null, "m0")
      const a = yield* send(api, chat.id, null, m0.slotId, "a")
      const { fork } = yield* api.CreateFork({ chatId: chat.id, fromForkId: main, atSlotId: m0.slotId })
      const b = yield* send(api, chat.id, fork.id, m0.slotId, "b")
      // Each fork's tip is its own: a send at the other fork's tip is a stale tab's.
      const moved = yield* api
        .SendMessage({ chatId: chat.id, forkId: main, parentSlotId: b.slotId, branch: false, content: "x" })
        .pipe(Effect.flip)
      assert.strictEqual(moved._tag, "LeafMoved")
      assert.strictEqual((moved as { activeLeafSlotId: string | null }).activeLeafSlotId, a.slotId)
      // At the old tip after the fork moved on, too.
      const stale = yield* api
        .SendMessage({ chatId: chat.id, forkId: fork.id, parentSlotId: m0.slotId, branch: false, content: "x" })
        .pipe(Effect.flip)
      assert.strictEqual((stale as { activeLeafSlotId: string | null }).activeLeafSlotId, b.slotId)
      // At its own tip it goes, though the other fork is current.
      assert.strictEqual(yield* current(api, chat.id), fork.id)
      yield* send(api, chat.id, main, a.slotId, "a2")
      assert.deepStrictEqual(yield* texts(api, chat.id, main), ["m0", "a", "a2"])
      assert.deepStrictEqual(yield* texts(api, chat.id, fork.id), ["m0", "b"])
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("two forks at the same message stay apart: a message in one never moves the other", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Checkpoint" })
      const main = chat.currentForkId!
      const m0 = yield* send(api, chat.id, null, null, "m0")
      const { fork } = yield* api.CreateFork({ chatId: chat.id, fromForkId: main, atSlotId: m0.slotId })
      const a = yield* typeInto(api, chat.id, main, "main's words")
      const b = yield* typeInto(api, chat.id, fork.id, "the checkpoint's words")
      assert.notStrictEqual(a.id, b.id)
      const sent = yield* send(api, chat.id, fork.id, m0.slotId, "on the checkpoint")
      // The new message is the fork's, and starts it among the alternates.
      const window = yield* api.ReadPath({
        chatId: chat.id,
        forkId: fork.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 10
      })
      assert.deepStrictEqual([window.entries.at(-1)!.forkId, window.entries.at(-1)!.startsForkId], [fork.id, fork.id])
      assert.deepStrictEqual(yield* texts(api, chat.id, main), ["m0"])
      const forks = yield* api.ListForks({ chatId: chat.id })
      assert.strictEqual(forks.find((f) => f.id === main)!.tipSlotId, m0.slotId)
      assert.strictEqual(forks.find((f) => f.id === fork.id)!.tipSlotId, sent.slotId)
      assert.strictEqual((yield* api.OpenComposer({ chatId: chat.id, forkId: main })).content, "main's words")
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("a fork is made only at a live message on its parent's path", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Paths" })
      const main = chat.currentForkId!
      const m0 = yield* send(api, chat.id, null, null, "m0")
      const m1 = yield* send(api, chat.id, null, m0.slotId, "m1")
      const { fork } = yield* api.CreateFork({ chatId: chat.id, fromForkId: main, atSlotId: m0.slotId })
      yield* send(api, chat.id, fork.id, m0.slotId, "b")
      // m1 isn't on the new fork's path.
      assert.strictEqual(
        yield* outcome(api.CreateFork({ chatId: chat.id, fromForkId: fork.id, atSlotId: m1.slotId })),
        "NotFound"
      )
      yield* api.DeleteMessage({ slotId: m1.slotId })
      assert.strictEqual(
        yield* outcome(api.CreateFork({ chatId: chat.id, fromForkId: main, atSlotId: m1.slotId })),
        "NotFound"
      )
      // Before the first message is anywhere's.
      const empty = yield* api.CreateFork({ chatId: chat.id, fromForkId: fork.id, atSlotId: null })
      assert.deepStrictEqual([empty.fork.baseSlotId, empty.fork.tipSlotId], [null, null])
      assert.deepStrictEqual(yield* texts(api, chat.id, null), [])
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("names and pins a fork; the chat lists its live forks, most recently current first", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Names" })
      const main = chat.currentForkId!
      const m0 = yield* send(api, chat.id, null, null, "m0")
      const { fork } = yield* api.CreateFork({ chatId: chat.id, fromForkId: main, atSlotId: m0.slotId })
      assert.deepStrictEqual(
        (yield* api.ListForks({ chatId: chat.id })).map((f) => [f.id, f.current]),
        [
          [fork.id, true],
          [main, false]
        ]
      )
      const named = yield* api.NameFork({ forkId: main, name: "  The\tmain line " })
      assert.strictEqual(named.name, "The main line")
      const pinned = yield* api.PinFork({ forkId: main, pinned: true })
      assert.isNotNull(pinned.pinnedAt)
      assert.isAbove(pinned.rowVersion, named.rowVersion)
      assert.strictEqual((yield* api.PinFork({ forkId: main, pinned: true })).pinnedAt, pinned.pinnedAt)
      assert.isNull((yield* api.PinFork({ forkId: main, pinned: false })).pinnedAt)
      // Its first message shows the name among its alternates.
      const [root] = yield* api.ListBranches({ slotId: m0.slotId })
      assert.strictEqual(root!.name, "The main line")
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("keeps a fork's tip in its chat, the active leaf the current fork's tip, and a fork's origin fixed", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Integrity" })
      const other = yield* api.CreateChat({ title: "Elsewhere" })
      const m0 = yield* send(api, chat.id, null, null, "m0")
      const x = yield* send(api, other.id, null, null, "x")
      const db = new DatabaseSync(databaseFile(config.dataDir))
      try {
        const run =
          (statement: string, ...params: Array<string>) =>
          () =>
            db.prepare(statement).run(...params)
        assert.throws(run("UPDATE forks SET tip_slot_id = ? WHERE id = ?", x.slotId, chat.id), /in its chat/)
        assert.throws(run("UPDATE chats SET current_fork_id = ? WHERE id = ?", other.id, chat.id), /one of its forks/)
        assert.throws(run("UPDATE forks SET base_slot_id = ? WHERE id = ?", m0.slotId, chat.id), /keeps the parent/)
        assert.throws(run("UPDATE forks SET chat_id = ? WHERE id = ?", other.id, chat.id), /never move/)
        // Either side of the mirror moves the other.
        db.prepare("UPDATE chats SET active_leaf_slot_id = NULL WHERE id = ?").run(chat.id)
        const tip = db.prepare("SELECT tip_slot_id AS tip FROM forks WHERE id = ?").get(chat.id) as { tip: unknown }
        assert.isNull(tip.tip)
        db.prepare("UPDATE forks SET tip_slot_id = ? WHERE id = ?").run(m0.slotId, chat.id)
        assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId, m0.slotId)
      } finally {
        db.close()
      }
    }).pipe(Effect.scoped, withServer(config))
  })
})
