// The recycle bin (DESIGN §6.2), through the real workers.
import { DatabaseSync } from "node:sqlite"
import { assert, describe, it } from "@effect/vitest"
import type { BinItem, BinLimits, RecoveredText } from "@rp/shared/bin.ts"
import { NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { composerKey } from "@rp/shared/drafts.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { ConnectionId } from "@rp/shared/providers.ts"
import { Effect } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { tempDir } from "./support/tempDir.ts"
import { cardDoc, presetDoc } from "./support/docs.ts"

const database = (dataDir = tempDir("bin"), binLimits?: BinLimits) =>
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
    const say = (content: string) =>
      new NewVersion({
        speakerEntityId: card.entityId,
        writer: "model",
        content,
        status: "complete",
        macroMode: "verbatim",
        origin: "generated"
      })
    const append = (parentSlotId: SlotId | null, content: string, branch = false) =>
      writer.AppendMessage({ userId, chatId: chat.id, parentSlotId, branch, version: say(content), commitDraft: null })
    const path = (leafSlotId: SlotId | null = null) =>
      reader
        .GetPath({ userId, chatId: chat.id, leafSlotId, limit: 100 })
        .pipe(Effect.map((w) => w.entries.map((e) => e.version.content)))
    const bin = () => reader.ListBin({ userId, limit: 100, before: null })
    const newChat = (title: string) =>
      writer.CreateChat({ userId, kind: "rp", status: "active", title, participants: [], greeting: null })
    // root → a → b → c
    const root = yield* append(null, "root")
    const a = yield* append(root.slotId, "a")
    const b = yield* append(a.slotId, "b")
    const c = yield* append(b.slotId, "c")
    return { writer, reader, userId, card, chat, say, append, path, bin, newChat, root, a, b, c }
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

  it.live("moving the tip back never deletes a composer's history without recovering its text", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, b, c, append } = yield* setup()
      const d = yield* append(b.slotId, "d", true) // b → {c, d}, at d
      const key = composerKey(chat.id, d.slotId)
      const typed = "A long reply typed at d, then wiped by a stray select-all."
      const draft = yield* writer.SaveDraft({
        userId,
        key,
        content: typed,
        expectedRowVersion: null,
        baseRevision: null
      })
      yield* writer.SaveDraft({ userId, key, content: "", expectedRowVersion: draft.rowVersion, baseRevision: null })
      yield* writer.DeleteMessage({ userId, slotId: d.slotId }) // the wiped composer moves to b
      yield* append(c.slotId, "e", true)
      yield* writer.DeleteBranch({ userId, slotId: c.slotId }) // back to b again
      const texts = yield* reader.ListRecoveredTexts({ userId, source: null, limit: 10, before: null })
      assert.deepStrictEqual(
        texts.map((t) => t.content),
        [typed]
      )
    }).pipe(Effect.provide(database()))
  )

  it.live("a branch goes as one item and comes back whole", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, a, b, c, path, append } = yield* setup()
      const other = yield* append(a.slotId, "other branch", true) // the active leaf is now on the other branch
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
        .AppendMessage({
          userId,
          chatId: chat.id,
          parentSlotId: c.slotId,
          branch: false,
          version: say("hello?"),
          commitDraft: null
        })
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
    const dir = tempDir("bin")
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
        (yield* reader.ListRecoveredTexts({ userId, source: null, limit: 10, before: null })).map((t) => t.content),
        ["three", "two"]
      )
      assert.strictEqual((yield* bin()).length, 2)
    }).pipe(
      Effect.provide(
        database(undefined, { deletedItems: 2, deletedBytes: 1e9, recoveredTexts: 2, recoveredBytes: 1e9 })
      )
    )
  )

  it.live("emptying the bin deletes everything in it for good", () => {
    const dir = tempDir("bin")
    return Effect.gen(function* () {
      const { writer, reader, userId, card, say, b, c, path, bin, newChat } = yield* setup()
      const swipe = yield* writer.AddVersion({
        userId,
        slotId: b.slotId,
        version: say("b, swipe"),
        select: false,
        commitDraft: null
      })
      yield* writer.DeleteVersion({ userId, versionId: swipe.id })
      yield* writer.DeleteMessage({ userId, slotId: b.slotId })
      yield* writer.DeleteVersion({ userId, versionId: c.version.id })
      const other = yield* newChat("Other")
      yield* writer.DeleteChat({ userId, chatId: other.id })
      yield* writer.DeleteEntity({ userId, entityId: card.entityId })

      assert.deepStrictEqual(yield* writer.EmptyBin({ userId }), { purged: 5 })
      assert.deepStrictEqual(yield* bin(), [])
      assert.deepStrictEqual(yield* path(), ["root", "a"])
      const db = new DatabaseSync(databaseFile(dir), { readOnly: true })
      const versions = db
        .prepare(`SELECT content FROM versions WHERE purged_at IS NOT NULL ORDER BY content`)
        .all()
        .map((r) => r.content)
      const chats = db.prepare(`SELECT count(*) AS n FROM chats WHERE id = ?`).get(other.id)
      db.close()
      assert.deepStrictEqual(versions, ["", "", ""])
      assert.deepStrictEqual(chats, { n: 0 })
      assert.deepStrictEqual(yield* reader.ListLibrary({ userId, kind: "card", tag: null, archived: false }), [])
    }).pipe(Effect.provide(database(dir)))
  })

  it.live(
    "a chat holding a connection's preset override can be evicted, and a failed eviction never blocks a delete",
    () => {
      const dir = tempDir("bin")
      return Effect.gen(function* () {
        const { writer, reader, userId, a, b, bin, newChat, path } = yield* setup()
        const preset = yield* writer.CreateEntity({
          userId,
          kind: "preset",
          label: "Narrator",
          subtitle: "",
          doc: presetDoc(),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
        const story = yield* newChat("Story")
        const override = yield* writer.CreateChatOverride({ userId, refId: preset.ref.id, chatId: story.id })
        const connection = yield* writer.CreateConnection({
          userId,
          connectionId: uuidv7() as ConnectionId,
          kind: "openai-chat",
          api: "openai-completions",
          settings: {
            name: "Local",
            baseUrl: "http://127.0.0.1:8081/v1",
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: override.id
          },
          credential: { existing: null }
        })
        yield* writer.DeleteChat({ userId, chatId: story.id })
        // The bin holds one item, so this delete evicts the chat for good.
        yield* writer.DeleteMessage({ userId, slotId: b.slotId })
        assert.deepStrictEqual(
          (yield* bin()).map((i) => i.excerpt),
          ["b"]
        )
        const after = yield* reader.GetConnection({ userId, connectionId: connection.id })
        assert.isNull(after.presetOverrideRefId)

        // A purge that fails at its last step is rolled back whole, skipped and left in the
        // bin; the delete goes through.
        const sqlite = (statement: string) => {
          const db = new DatabaseSync(databaseFile(dir))
          db.exec(statement)
          db.close()
        }
        sqlite(`CREATE TRIGGER purge_fails BEFORE DELETE ON bin_items BEGIN SELECT RAISE(ABORT, 'injected'); END`)
        yield* writer.DeleteMessage({ userId, slotId: a.slotId })
        const items = yield* bin()
        assert.deepStrictEqual(
          items.map((i) => i.excerpt),
          ["a", "b"]
        )
        sqlite(`DROP TRIGGER purge_fails`)
        yield* writer.RestoreBinItem({ userId, itemId: items[1]!.id })
        assert.deepStrictEqual(yield* path(), ["root", "b", "c"])
      }).pipe(
        Effect.provide(database(dir, { deletedItems: 1, deletedBytes: 1e9, recoveredTexts: 10, recoveredBytes: 1e9 }))
      )
    }
  )

  it.live("eviction never takes the item just deleted, and takes nothing if it can't make room", () => {
    const dir = tempDir("bin")
    return Effect.gen(function* () {
      const { writer, userId, root, a, b, c, bin } = yield* setup()
      const excerpts = () => bin().pipe(Effect.map((items) => items.map((i) => i.excerpt)))
      const sqlite = (statement: string) => {
        const db = new DatabaseSync(databaseFile(dir))
        db.exec(statement)
        db.close()
      }
      yield* writer.DeleteMessage({ userId, slotId: b.slotId })
      sqlite(`CREATE TRIGGER b_stuck BEFORE UPDATE OF purged_at ON slots WHEN OLD.id = '${b.slotId}'
              BEGIN SELECT RAISE(ABORT, 'injected'); END`)
      // b can't go, and the new item stays: the bin is left over its one-item limit.
      yield* writer.DeleteMessage({ userId, slotId: a.slotId })
      assert.deepStrictEqual(yield* excerpts(), ["a", "b"])
      // Taking a would still leave b and c, so nothing goes.
      yield* writer.DeleteMessage({ userId, slotId: c.slotId })
      assert.deepStrictEqual(yield* excerpts(), ["c", "a", "b"])
      // Once b can go, the next delete evicts oldest first down to the limit.
      sqlite(`DROP TRIGGER b_stuck`)
      yield* writer.DeleteMessage({ userId, slotId: root.slotId })
      assert.deepStrictEqual(yield* excerpts(), ["root"])
    }).pipe(
      Effect.provide(database(dir, { deletedItems: 1, deletedBytes: 1e9, recoveredTexts: 10, recoveredBytes: 1e9 }))
    )
  })

  it.live("an item over the byte limit on its own is kept, and evicts nothing", () =>
    Effect.gen(function* () {
      const { writer, userId, a, c, append, bin } = yield* setup()
      yield* writer.DeleteMessage({ userId, slotId: a.slotId })
      const long = yield* append(c.slotId, "A message longer than the limit.")
      yield* writer.DeleteMessage({ userId, slotId: long.slotId })
      assert.deepStrictEqual(
        (yield* bin()).map((i) => i.excerpt),
        ["A message longer than the limit.", "a"]
      )
    }).pipe(
      Effect.provide(
        database(undefined, { deletedItems: 10, deletedBytes: 3, recoveredTexts: 10, recoveredBytes: 1e9 })
      )
    )
  )

  it.live("sizes count bytes of everything a purge frees, and nothing already in the bin twice", () =>
    Effect.gen(function* () {
      const { writer, userId, chat, card, a, b } = yield* setup()
      const cat = "猫".repeat(1000) // 1,000 characters, 3,000 bytes
      const swipe = yield* writer.AddVersion({
        userId,
        slotId: b.slotId,
        version: new NewVersion({
          speakerEntityId: card.entityId,
          writer: "model",
          content: cat,
          direction: "terse",
          status: "complete",
          macroMode: "verbatim",
          origin: "generated"
        }),
        select: false,
        commitDraft: null
      })
      assert.strictEqual((yield* writer.DeleteVersion({ userId, versionId: swipe.id })).byteSize, 3005)
      // Each later item leaves out what's already in the bin under an earlier one.
      assert.strictEqual((yield* writer.DeleteMessage({ userId, slotId: b.slotId })).byteSize, 1) // "b"
      assert.strictEqual((yield* writer.DeleteBranch({ userId, slotId: a.slotId })).byteSize, 2) // "a", "c"
      // "root", and the state event that made the card a participant
      const joined = JSON.stringify({ entity: card.entityId }).length
      assert.strictEqual((yield* writer.DeleteChat({ userId, chatId: chat.id })).byteSize, 4 + joined)
    }).pipe(Effect.provide(database()))
  )

  it.live("a chat's size counts its agent runs and state, and an entity's its search text", () => {
    const dir = tempDir("bin")
    return Effect.gen(function* () {
      const { writer, userId, card, newChat } = yield* setup()
      const story = yield* newChat("Story") // no messages
      const db = new DatabaseSync(databaseFile(dir))
      db.prepare(
        `INSERT INTO rollouts (id, chat_id, kind, status, role, request_class, error, created_at, updated_at)
         VALUES ('r1', ?, 'generation', 'failed', 'narrator', 'interactive', 'oops', 0, 0)`
      ).run(story.id)
      db.exec(`INSERT INTO rollout_payloads VALUES ('r1', '{"a":1}', '["猫"]')`)
      db.prepare(
        `INSERT INTO state_events (id, chat_id, seq, key, value_json, origin, created_at)
         VALUES ('e1', ?, 1, 'var.set', '"雨"', 'user', 0)`
      ).run(story.id)
      const [entityBytes] = db
        .prepare(
          `SELECT sum(length(CAST(doc_json AS BLOB)) + length(CAST(search_text AS BLOB))) AS n
           FROM entity_revisions WHERE entity_id = ?`
        )
        .all(card.entityId)
      db.close()
      // "oops", {"a":1}, ["猫"] and "雨"
      assert.strictEqual((yield* writer.DeleteChat({ userId, chatId: story.id })).byteSize, 4 + 7 + 7 + 5)
      assert.strictEqual((yield* writer.DeleteEntity({ userId, entityId: card.entityId })).byteSize, entityBytes!.n)
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("pages through items deleted in the same millisecond without skipping any", () => {
    const dir = tempDir("bin")
    return Effect.gen(function* () {
      const { writer, reader, userId, chat, a, b, c } = yield* setup()
      for (const slot of [a, b, c]) yield* writer.DeleteMessage({ userId, slotId: slot.slotId })
      for (const text of ["one", "two", "three"]) {
        const key = composerKey(chat.id, null)
        const draft = yield* writer.SaveDraft({
          userId,
          key,
          content: text,
          expectedRowVersion: (yield* reader.GetDraft({ userId, key }))?.rowVersion ?? null,
          baseRevision: null
        })
        yield* writer.ClearDraft({ userId, key, outcome: "discarded", expectedRowVersion: draft.rowVersion })
      }
      const db = new DatabaseSync(databaseFile(dir))
      db.exec(`UPDATE bin_items SET deleted_at = 1000; UPDATE recovered_texts SET created_at = 1000`)
      db.close()

      // One per page, each page asking for what comes after the last one seen.
      const items: Array<BinItem> = []
      for (;;) {
        const last = items.at(-1)
        const page = yield* reader.ListBin({
          userId,
          limit: 1,
          before: last ? { deletedAt: last.deletedAt, id: last.id } : null
        })
        if (page.length === 0) break
        items.push(...page)
      }
      assert.deepStrictEqual(items.map((i) => i.excerpt).sort(), ["a", "b", "c"])

      const texts: Array<RecoveredText> = []
      for (;;) {
        const last = texts.at(-1)
        const page = yield* reader.ListRecoveredTexts({
          userId,
          source: null,
          limit: 1,
          before: last ? { createdAt: last.createdAt, id: last.id } : null
        })
        if (page.length === 0) break
        texts.push(...page)
      }
      assert.deepStrictEqual(texts.map((t) => t.content).sort(), ["one", "three", "two"])
    }).pipe(Effect.provide(database(dir)))
  })

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
