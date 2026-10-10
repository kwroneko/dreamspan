// The recycle bin (DESIGN §6.2), through the real workers.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { assert, describe, it } from "@effect/vitest"
import type { BinLimits } from "@rp/shared/bin.ts"
import { NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { composerKey } from "@rp/shared/drafts.ts"
import { Effect } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"

const database = (dataDir = mkdtempSync(join(tmpdir(), "rp-bin-")), binLimits?: BinLimits) =>
  Database.layer({
    dataDir,
    readers: 2,
    allowNetworkFs: false,
    workers: "source",
    ...(binLimits ? { binLimits } : {})
  })

const setup = (handle = "ana") =>
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const user = yield* writer.EnsureUser({ handle, displayName: handle })
    const userId = user.id
    const card = yield* writer.CreateEntity({
      userId,
      kind: "card",
      label: "Mira",
      subtitle: "",
      doc: { name: "Mira" },
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
    const say = (content: string) =>
      new NewVersion({
        speakerEntityId: card.entityId,
        writer: "model",
        content,
        status: "complete",
        macroMode: "verbatim",
        origin: "generated"
      })
    const append = (parentSlotId: SlotId | null, content: string) =>
      writer.AppendMessage({ userId, chatId: chat.id, parentSlotId, version: say(content), commitDraft: null })
    const path = (leafSlotId: SlotId | null = null) =>
      reader
        .GetPath({ userId, chatId: chat.id, leafSlotId, limit: 100 })
        .pipe(Effect.map((w) => w.entries.map((e) => e.version.content)))
    const bin = () => reader.ListBin({ userId, limit: 100, before: null })
    // root → a → b → c
    const root = yield* append(null, "root")
    const a = yield* append(root.slotId, "a")
    const b = yield* append(a.slotId, "b")
    const c = yield* append(b.slotId, "c")
    return { writer, reader, userId, card, chat, say, append, path, bin, root, a, b, c }
  })

describe("recycle bin", () => {
  it.live("deleting a swipe shows the previous one; restoring brings it back", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, say, b, path } = yield* setup()
      yield* writer.AddVersion({
        userId,
        slotId: b.slotId,
        version: say("b, second take"),
        select: true,
        commitDraft: null
      })
      const third = yield* writer.AddVersion({
        userId,
        slotId: b.slotId,
        version: say("b, third take"),
        select: true,
        commitDraft: null
      })

      const item = yield* writer.DeleteVersion({ userId, versionId: third.id })
      assert.strictEqual(item.kind, "version")
      assert.strictEqual(item.excerpt, "b, third take")
      assert.deepStrictEqual(yield* path(), ["root", "a", "b, second take", "c"])
      const versions = (yield* reader.ListVersions({ userId, slotId: b.slotId })).map((v) => v.content)
      assert.deepStrictEqual(versions, ["b", "b, second take"])

      yield* writer.RestoreBinItem({ userId, itemId: item.id })
      assert.strictEqual((yield* reader.ListVersions({ userId, slotId: b.slotId })).length, 3)
    }).pipe(Effect.provide(database()))
  )

  it.live("deleting a message's only version deletes the message", () =>
    Effect.gen(function* () {
      const { writer, userId, b, path } = yield* setup()
      const item = yield* writer.DeleteVersion({ userId, versionId: b.version.id })
      assert.strictEqual(item.kind, "message")
      assert.deepStrictEqual(yield* path(), ["root", "a", "c"])
    }).pipe(Effect.provide(database()))
  )

  it.live("a deleted message disappears from the conversation, its replies stay, and it restores in place", () =>
    Effect.gen(function* () {
      const { writer, userId, b, path, bin } = yield* setup()
      const item = yield* writer.DeleteMessage({ userId, slotId: b.slotId })
      assert.deepStrictEqual(yield* path(), ["root", "a", "c"])
      const [listed] = yield* bin()
      assert.strictEqual(listed!.title, 'Message in "Harbor"')
      assert.strictEqual(listed!.origin.depth, 2)

      yield* writer.RestoreBinItem({ userId, itemId: item.id })
      assert.deepStrictEqual(yield* path(), ["root", "a", "b", "c"])
      assert.deepStrictEqual(yield* bin(), [])
    }).pipe(Effect.provide(database()))
  )

  it.live("deleting the message you're at moves the tip back, and the composer with it", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, b, c, path } = yield* setup()
      yield* writer.SaveDraft({
        userId,
        key: composerKey(chat.id, c.slotId),
        content: "half-typed",
        expectedRowVersion: null,
        baseRevision: null
      })
      yield* writer.DeleteMessage({ userId, slotId: c.slotId })
      assert.strictEqual((yield* reader.GetChat({ userId, chatId: chat.id })).activeLeafSlotId, b.slotId)
      assert.deepStrictEqual(yield* path(), ["root", "a", "b"])
      assert.strictEqual(
        (yield* reader.GetDraft({ userId, key: composerKey(chat.id, b.slotId) }))?.content,
        "half-typed"
      )
    }).pipe(Effect.provide(database()))
  )

  it.live("a branch goes as one item and comes back whole", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, a, b, c, path, append } = yield* setup()
      const other = yield* append(a.slotId, "other branch") // the active leaf is now on the other branch
      const item = yield* writer.DeleteBranch({ userId, slotId: b.slotId })
      assert.strictEqual(item.title, 'Branch of 2 messages in "Harbor"')
      assert.deepStrictEqual(yield* path(c.slotId), ["root", "a"])
      assert.deepStrictEqual(yield* path(other.slotId), ["root", "a", "other branch"])

      yield* writer.RestoreBinItem({ userId, itemId: item.id })
      assert.deepStrictEqual(yield* path(c.slotId), ["root", "a", "b", "c"])
      assert.strictEqual((yield* reader.GetChat({ userId, chatId: chat.id })).activeLeafSlotId, other.slotId)
    }).pipe(Effect.provide(database()))
  )

  it.live("deleted chats and cards disappear everywhere until restored", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, card, say, c } = yield* setup()
      const chatItem = yield* writer.DeleteChat({ userId, chatId: chat.id })
      assert.strictEqual(chatItem.title, "Harbor")
      assert.strictEqual((yield* reader.GetChat({ userId, chatId: chat.id }).pipe(Effect.flip))._tag, "NotFound")
      const write = yield* writer
        .AppendMessage({ userId, chatId: chat.id, parentSlotId: c.slotId, version: say("hello?"), commitDraft: null })
        .pipe(Effect.flip)
      assert.strictEqual(write._tag, "NotFound")
      yield* writer.RestoreBinItem({ userId, itemId: chatItem.id })
      assert.strictEqual((yield* reader.GetChat({ userId, chatId: chat.id })).title, "Harbor")

      const cardItem = yield* writer.DeleteEntity({ userId, entityId: card.entityId })
      assert.strictEqual(cardItem.title, "Mira")
      assert.deepStrictEqual(yield* reader.ListLibrary({ userId, kind: "card", tag: null, archived: false }), [])
      yield* writer.RestoreBinItem({ userId, itemId: cardItem.id })
      assert.strictEqual((yield* reader.ListLibrary({ userId, kind: "card", tag: null, archived: false })).length, 1)
    }).pipe(Effect.provide(database()))
  )

  it.live("deleting a message for good erases its content and leaves an empty placeholder", () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-bin-"))
    return Effect.gen(function* () {
      const { writer, userId, say, b, path, bin } = yield* setup()
      const swipe = yield* writer.AddVersion({
        userId,
        slotId: b.slotId,
        version: say("b, swipe"),
        select: false,
        commitDraft: null
      })
      yield* writer.DeleteVersion({ userId, versionId: swipe.id })
      const item = yield* writer.DeleteMessage({ userId, slotId: b.slotId })
      yield* writer.PurgeBinItem({ userId, itemId: item.id })

      assert.deepStrictEqual(yield* path(), ["root", "a", "c"])
      // The swipe deleted separately inside it has nothing left to restore either.
      assert.deepStrictEqual(yield* bin(), [])
      const db = new DatabaseSync(databaseFile(dir), { readOnly: true })
      const rows = db.prepare(`SELECT content, purged_at FROM versions WHERE slot_id = ?`).all(b.slotId) as Array<{
        content: string
        purged_at: number | null
      }>
      db.close()
      assert.deepStrictEqual(
        rows.map((r) => [r.content, r.purged_at !== null]),
        [
          ["", true],
          ["", true]
        ]
      )
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("deleting a chat for good takes its other bin items with it", () =>
    Effect.gen(function* () {
      const { writer, userId, chat, b, bin } = yield* setup()
      yield* writer.DeleteMessage({ userId, slotId: b.slotId })
      const chatItem = yield* writer.DeleteChat({ userId, chatId: chat.id })
      assert.strictEqual((yield* bin()).length, 2)
      yield* writer.PurgeBinItem({ userId, itemId: chatItem.id })
      assert.deepStrictEqual(yield* bin(), [])
    }).pipe(Effect.provide(database()))
  )

  it.live("each section evicts its own oldest entries, never the other's", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, a, b, c, bin } = yield* setup()
      // Three deletes into a two-item section: the oldest goes for good.
      yield* writer.DeleteMessage({ userId, slotId: a.slotId })
      yield* writer.DeleteMessage({ userId, slotId: b.slotId })
      yield* writer.DeleteMessage({ userId, slotId: c.slotId })
      assert.deepStrictEqual(
        (yield* bin()).map((i) => i.excerpt),
        ["c", "b"]
      )

      // Three discarded drafts into a two-text section don't touch the deleted items.
      for (const text of ["one", "two", "three"]) {
        const draft = yield* writer.SaveDraft({
          userId,
          key: composerKey(chat.id, null),
          content: text,
          expectedRowVersion: (yield* reader.GetDraft({ userId, key: composerKey(chat.id, null) }))?.rowVersion ?? null,
          baseRevision: null
        })
        yield* writer.ClearDraft({ userId, key: draft.key, outcome: "discarded", expectedRowVersion: draft.rowVersion })
      }
      assert.deepStrictEqual(
        (yield* reader.ListRecoveredTexts({ userId, source: null, limit: 10 })).map((t) => t.content),
        ["three", "two"]
      )
      assert.strictEqual((yield* bin()).length, 2)
    }).pipe(
      Effect.provide(
        database(undefined, { deletedItems: 2, deletedBytes: 1e9, recoveredTexts: 2, recoveredBytes: 1e9 })
      )
    )
  )

  it.live("a user can't see or restore another user's bin", () =>
    Effect.gen(function* () {
      const ana = yield* setup("ana")
      const bob = yield* setup("bob")
      const item = yield* ana.writer.DeleteMessage({ userId: ana.userId, slotId: ana.b.slotId })
      assert.deepStrictEqual(yield* bob.bin(), [])
      const tag = (yield* bob.writer.RestoreBinItem({ userId: bob.userId, itemId: item.id }).pipe(Effect.flip))._tag
      assert.strictEqual(tag, "NotFound")
      const del = (yield* bob.writer.DeleteMessage({ userId: bob.userId, slotId: ana.c.slotId }).pipe(Effect.flip))._tag
      assert.strictEqual(del, "NotFound")
    }).pipe(Effect.provide(database()))
  )
})
