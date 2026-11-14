// Several messages deleted as one change, and its Undo (job msgactions1), through the real workers:
// each exactly as DeleteMessage deletes one, branch-local, atomic, restored together.
import { assert, describe, it } from "@effect/vitest"
import { type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { Effect, Exit } from "effect"
import * as Database from "../src/db/Database.ts"
import { testWorkers } from "./support/bundles.ts"
import { cardDoc } from "./support/docs.ts"
import { tempDir } from "./support/tempDir.ts"

const database = () =>
  Database.layer({ dataDir: tempDir("multidelete"), readers: 2, allowNetworkFs: false, ...testWorkers })

/** root → a → b → c → d in the chat's first fork. */
const setup = (handle = "ana") =>
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const { id: userId } = yield* writer.EnsureUser({ handle, displayName: handle })
    const card = yield* writer.CreateEntity({
      userId,
      kind: "card",
      label: "Mira",
      subtitle: "",
      doc: cardDoc("Mira"),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    const chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "Harbor",
      participants: [card.entityId],
      greeting: null
    })
    const append = (parentSlotId: SlotId | null, content: string, branch = false) =>
      writer.AppendMessage({
        userId,
        chatId: chat.id,
        parentSlotId,
        branch,
        version: new NewVersion({
          speakerEntityId: card.entityId,
          writer: "model",
          content,
          status: "complete",
          macroMode: "verbatim",
          origin: "generated"
        }),
        commitDraft: null
      })
    const path = (forkId: ForkId) =>
      reader
        .GetPath({ userId, chatId: chat.id, forkId, leafSlotId: null, limit: 100 })
        .pipe(Effect.map((w) => w.entries.map((e) => e.version.content)))
    const root = yield* append(null, "root")
    const a = yield* append(root.slotId, "a")
    const b = yield* append(a.slotId, "b")
    const c = yield* append(b.slotId, "c")
    const d = yield* append(c.slotId, "d")
    const fork = chat.currentForkId!
    return { writer, reader, userId, chat, append, path, fork, root, a, b, c, d }
  })

describe("deleting several messages", () => {
  it.live("the last messages go as one change; Undo brings each back where it was", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, path, fork, b, c, d } = yield* setup()
      const items = yield* writer.DeleteMessages({ userId, forkId: fork, slotIds: [b.slotId, c.slotId, d.slotId] })
      assert.deepStrictEqual(
        items.map((item) => [item.kind, item.targetId]),
        [
          ["message", b.slotId],
          ["message", c.slotId],
          ["message", d.slotId]
        ]
      )
      // One group, named on each item; the bin keeps each as a message of its own.
      const groups = new Set(items.map((item) => item.origin.group))
      assert.strictEqual(groups.size, 1)
      assert.isTrue(items.every((item) => item.origin.groupSize === 3 && item.origin.forkId === fork))
      assert.deepStrictEqual(yield* path(fork), ["root", "a"])
      assert.strictEqual((yield* reader.ListBin({ userId, limit: 10, before: null })).length, 3)

      const restored = yield* writer.RestoreBinItems({ userId, itemIds: items.map((item) => item.id) })
      assert.strictEqual(restored.length, 3)
      assert.deepStrictEqual(yield* path(fork), ["root", "a", "b", "c", "d"])
      assert.strictEqual((yield* reader.ListBin({ userId, limit: 10, before: null })).length, 0)
      // A second Undo finds nothing left to restore.
      const again = yield* Effect.exit(writer.RestoreBinItems({ userId, itemIds: items.map((item) => item.id) }))
      assert.isTrue(Exit.isFailure(again))
    }).pipe(Effect.provide(database()))
  )

  it.live("messages in the middle go; their replies stay", () =>
    Effect.gen(function* () {
      const { writer, userId, path, fork, a, c } = yield* setup()
      const items = yield* writer.DeleteMessages({ userId, forkId: fork, slotIds: [a.slotId, c.slotId] })
      assert.deepStrictEqual(yield* path(fork), ["root", "b", "d"])
      yield* writer.RestoreBinItems({ userId, itemIds: items.map((item) => item.id) })
      assert.deepStrictEqual(yield* path(fork), ["root", "a", "b", "c", "d"])
    }).pipe(Effect.provide(database()))
  )

  it.live("Undo past a message deleted before brings the tip back to the end, with no new branch", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, path, fork, b, c, d } = yield* setup()
      // b went earlier, on its own: c's parent stays deleted through the Undo.
      yield* writer.DeleteMessage({ userId, slotId: b.slotId, forkId: fork })
      const items = yield* writer.DeleteMessages({ userId, forkId: fork, slotIds: [c.slotId, d.slotId] })
      assert.deepStrictEqual(yield* path(fork), ["root", "a"])
      yield* writer.RestoreBinItems({ userId, itemIds: items.map((item) => item.id) })
      assert.deepStrictEqual(yield* path(fork), ["root", "a", "c", "d"])
      assert.strictEqual((yield* reader.ListForks({ userId, chatId: chat.id })).length, 1)
    }).pipe(Effect.provide(database()))
  )

  it.live("branch-local: another branch that shows them keeps them", () =>
    Effect.gen(function* () {
      const { writer, userId, path, fork, append, a, b, c } = yield* setup()
      const other = yield* append(c.slotId, "other", true)
      assert.notStrictEqual(other.forkId, fork)
      yield* writer.DeleteMessages({ userId, forkId: fork, slotIds: [a.slotId, b.slotId] })
      assert.deepStrictEqual(yield* path(fork), ["root", "c", "d"])
      assert.deepStrictEqual(yield* path(other.forkId as ForkId), ["root", "a", "b", "c", "other"])
    }).pipe(Effect.provide(database()))
  )

  it.live("all or nothing: a message not live in the fork deletes none", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, path, fork, a, b } = yield* setup()
      yield* writer.DeleteMessage({ userId, slotId: b.slotId, forkId: fork })
      const exit = yield* Effect.exit(writer.DeleteMessages({ userId, forkId: fork, slotIds: [a.slotId, b.slotId] }))
      assert.isTrue(Exit.isFailure(exit))
      assert.deepStrictEqual(yield* path(fork), ["root", "a", "c", "d"])
      assert.strictEqual((yield* reader.ListBin({ userId, limit: 10, before: null })).length, 1)
      // Another user's message is NotFound too, and nothing of one's own goes with it.
      const other = yield* setup("bo")
      const mixed = yield* Effect.exit(
        writer.DeleteMessages({ userId: other.userId, forkId: other.fork, slotIds: [other.a.slotId, a.slotId] })
      )
      assert.isTrue(Exit.isFailure(mixed))
      assert.deepStrictEqual(yield* other.path(other.fork), ["root", "a", "b", "c", "d"])
    }).pipe(Effect.provide(database()))
  )

  it.live("leaves the chat as deleting the same messages one at a time does", () =>
    Effect.gen(function* () {
      const one = yield* setup("one")
      const many = yield* setup("many")
      for (const s of [one, many]) yield* s.append(s.b.slotId, "side", true)
      for (const slot of [one.b, one.d])
        yield* one.writer.DeleteMessage({ userId: one.userId, slotId: slot.slotId, forkId: one.fork })
      yield* many.writer.DeleteMessages({
        userId: many.userId,
        forkId: many.fork,
        slotIds: [many.b.slotId, many.d.slotId]
      })
      const forks = (s: typeof one) =>
        s.reader.ListForks({ userId: s.userId, chatId: s.chat.id }).pipe(Effect.map((list) => list.map((f) => f.id)))
      const shape = (s: typeof one) =>
        Effect.gen(function* () {
          const ids = yield* forks(s)
          return yield* Effect.forEach(ids, (id) => s.path(id as ForkId))
        })
      assert.deepStrictEqual(yield* shape(many), yield* shape(one))
    }).pipe(Effect.provide(database()))
  )
})
