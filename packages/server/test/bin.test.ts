// The recycle bin (DESIGN §6.2), through the real workers.
import { newChatLcm } from "@rp/shared/lcmSettings.ts"
import { DatabaseSync } from "node:sqlite"
import { assert, describe, it } from "@effect/vitest"
import type { BinItem, BinLimits, RecoveredText } from "@rp/shared/bin.ts"
import { type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { composerKey } from "@rp/shared/drafts.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { ConnectionId } from "@rp/shared/providers.ts"
import { Effect } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { tempDir } from "./support/tempDir.ts"
import { cardDoc, presetDoc } from "./support/docs.ts"
import { testWorkers } from "./support/bundles.ts"

/** A chain of forks deeper than tests otherwise make: fork labels have no cap. */
const DEEP = 70

const database = (dataDir = tempDir("bin"), binLimits?: BinLimits) =>
  Database.layer({
    dataDir,
    readers: 2,
    allowNetworkFs: false,
    ...testWorkers,
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

  it.live("deleting the message you're at moves the fork's tip back, its composer staying with it", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, b, c, path } = yield* setup()
      yield* writer.SaveDraft({
        draftId: null,
        expectedSession: null,
        userId,
        key: composerKey(chat.id, chat.currentForkId),
        content: "half-typed",
        expectedRowVersion: null,
        baseRevision: null
      })
      yield* writer.DeleteMessage({ userId, slotId: c.slotId })
      assert.strictEqual((yield* reader.GetChat({ userId, chatId: chat.id })).activeLeafSlotId, b.slotId)
      assert.deepStrictEqual(yield* path(), ["root", "a", "b"])
      assert.strictEqual(
        (yield* reader.GetDraft({ userId, key: composerKey(chat.id, chat.currentForkId) }))?.content,
        "half-typed"
      )
    }).pipe(Effect.provide(database()))
  )

  it.live("deleting and restoring a branch keeps its forks and their drafts apart from surviving composers", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, b, c, append } = yield* setup()
      const key = composerKey(chat.id, chat.currentForkId)
      const draft = yield* writer.SaveDraft({
        draftId: null,
        expectedSession: null,
        userId,
        key,
        content: "Important unsent paragraph",
        expectedRowVersion: null,
        baseRevision: null
      })
      // Another fork, made at b, is the one chatted in last.
      const d = yield* append(b.slotId, "d", true)
      const item = yield* writer.DeleteFork({ userId, forkId: chat.currentForkId! })
      assert.strictEqual((yield* reader.GetDraft({ userId, key }))?.content, "Important unsent paragraph")
      // The first fork went with the branch; the chat stays on the other.
      assert.deepStrictEqual(
        (yield* reader.ListForks({ userId, chatId: chat.id })).map((f) => f.id),
        [d.forkId]
      )
      // A save already in flight still names the deleted branch's draft.
      yield* writer.SaveDraft({
        draftId: draft.id,
        expectedSession: draft.session,
        userId,
        key,
        content: "Important unsent paragraph, continued",
        expectedRowVersion: draft.rowVersion,
        baseRevision: null
      })
      yield* writer.SaveDraft({
        draftId: null,
        expectedSession: null,
        userId,
        key: composerKey(chat.id, d.forkId),
        content: "Text typed after deletion",
        expectedRowVersion: null,
        baseRevision: null
      })
      yield* writer.RestoreBinItem({ userId, itemId: item.id })
      // The fork comes back as it was, tip and draft; the chat stays on the fork it's on.
      const forks = yield* reader.ListForks({ userId, chatId: chat.id })
      assert.strictEqual(forks.find((f) => f.id === chat.currentForkId)?.tipSlotId, c.slotId)
      assert.strictEqual((yield* reader.GetChat({ userId, chatId: chat.id })).currentForkId, d.forkId)
      assert.strictEqual((yield* reader.GetDraft({ userId, key }))?.content, "Important unsent paragraph, continued")
      assert.strictEqual(
        (yield* reader.GetDraft({ userId, key: composerKey(chat.id, d.forkId) }))?.content,
        "Text typed after deletion"
      )
    }).pipe(Effect.provide(database()))
  )

  it.live("a chat's last fork isn't deleted", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, c, path } = yield* setup()
      const refused = yield* writer.DeleteFork({ userId, forkId: chat.currentForkId! }).pipe(Effect.flip)
      assert.strictEqual(refused._tag, "CannotDeleteLastFork")
      const after = yield* reader.GetChat({ userId, chatId: chat.id })
      assert.deepStrictEqual([after.currentForkId, after.activeLeafSlotId], [chat.currentForkId, c.slotId])
      assert.deepStrictEqual(yield* path(), ["root", "a", "b", "c"])
      assert.deepStrictEqual(yield* reader.ListBin({ userId, limit: 10, before: null }), [])
    }).pipe(Effect.provide(database()))
  )

  it.live("moving a fork's tip back keeps its composer and its history", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, b, c, append } = yield* setup()
      const d = yield* append(b.slotId, "d", true) // b → {c, d}: a fork at d
      const key = composerKey(chat.id, d.forkId)
      const typed = "A long reply typed at d, then wiped by a stray select-all."
      const draft = yield* writer.SaveDraft({
        draftId: null,
        expectedSession: null,
        userId,
        key,
        content: typed,
        expectedRowVersion: null,
        baseRevision: null
      })
      yield* writer.SaveDraft({
        draftId: draft.id,
        expectedSession: draft.session,
        userId,
        key,
        content: "",
        expectedRowVersion: draft.rowVersion,
        baseRevision: null
      })
      yield* writer.DeleteMessage({ userId, slotId: d.slotId }) // d's fork goes back to b
      const e = yield* append(c.slotId, "e", true) // continues the first fork, at c
      assert.strictEqual(e.forkId, chat.currentForkId)
      yield* writer.DeleteMessage({ userId, slotId: c.slotId })
      yield* writer.DeleteMessage({ userId, slotId: e.slotId }) // back to b as well
      // Nothing moved between composers, so nothing was lost or merged: the wiped text is
      // one step back in its own draft's history.
      assert.deepStrictEqual(yield* reader.ListRecoveredTexts({ userId, source: null, limit: 10, before: null }), [])
      const history = yield* reader.DraftHistory({ userId, key, limit: 10 })
      assert.isAtLeast(history.length, 2)
      const [, before] = history
      assert.strictEqual((yield* reader.GetDraftState({ userId, key, seq: before!.seq })).content, typed)
    }).pipe(Effect.provide(database()))
  )

  it.live("a branch goes as one item and comes back whole", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, a, c, path, append } = yield* setup()
      const other = yield* append(a.slotId, "other branch", true) // the active leaf is now on the other branch
      const item = yield* writer.DeleteFork({ userId, forkId: chat.currentForkId! })
      assert.strictEqual(item.title, 'Fork of 2 messages in "Harbor"')
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
      for (const [key, value] of [
        ["deletedItems", 2],
        ["deletedBytes", 1e9],
        ["recoveredTexts", 2],
        ["recoveredBytes", 1e9]
      ] as const) {
        yield* writer.ChangeBinLimit({ userId, key, value })
      }
      // Three deletes into a two-item section: the oldest goes for good.
      yield* writer.DeleteMessage({ userId, slotId: a.slotId })
      yield* writer.DeleteMessage({ userId, slotId: b.slotId })
      yield* writer.DeleteMessage({ userId, slotId: c.slotId })
      assert.deepStrictEqual(
        (yield* bin()).map((i) => i.excerpt),
        ["c", "b"]
      )

      // Three discarded drafts into a two-text section don't touch the deleted items.
      for (const text of ["one", "two", "three", "four"]) {
        const draft = yield* writer.SaveDraft({
          draftId: null,
          expectedSession: null,
          userId,
          key: composerKey(chat.id, chat.currentForkId),
          content: text,
          expectedRowVersion:
            (yield* reader.GetDraft({ userId, key: composerKey(chat.id, chat.currentForkId) }))?.rowVersion ?? null,
          baseRevision: null
        })
        yield* writer.ClearDraft({
          userId,
          key: draft.key,
          draftId: draft.id,
          outcome: "discarded",
          expectedRowVersion: draft.rowVersion
        })
        if (text === "three") {
          assert.deepStrictEqual(
            (yield* reader.ListRecoveredTexts({ userId, source: null, limit: 10, before: null })).map((t) => t.content),
            ["three", "two"]
          )
          yield* writer.ChangeBinLimit({ userId, key: "recoveredBytes", value: 6 })
        }
      }
      assert.deepStrictEqual(
        (yield* reader.ListRecoveredTexts({ userId, source: null, limit: 10, before: null })).map((t) => t.content),
        ["four"]
      )
      assert.strictEqual((yield* bin()).length, 2)
    }).pipe(Effect.provide(database()))
  )

  it.live("the saved deleted-byte limit evicts oldest items independently of the item limit", () =>
    Effect.gen(function* () {
      const { writer, userId, a, b, c, bin } = yield* setup()
      yield* writer.ChangeBinLimit({ userId, key: "deletedItems", value: 100 })
      const first = yield* writer.DeleteMessage({ userId, slotId: a.slotId })
      assert.isAbove(first.byteSize, 0)
      yield* writer.ChangeBinLimit({ userId, key: "deletedBytes", value: first.byteSize * 2 })
      yield* writer.DeleteMessage({ userId, slotId: b.slotId })
      yield* writer.DeleteMessage({ userId, slotId: c.slotId })
      assert.deepStrictEqual(
        (yield* bin()).map((item) => item.targetId),
        [c.slotId, b.slotId]
      )
    }).pipe(Effect.provide(database()))
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

      assert.strictEqual((yield* writer.EmptyBin({ userId, itemIds: (yield* bin()).map((item) => item.id) })).purged, 5)
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

  it.live("a chat holding a connection's preset can be evicted, and a failed eviction never blocks a delete", () => {
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
          presetOverrideRefId: preset.ref.id
        },
        credential: { existing: null }
      })
      yield* writer.DeleteChat({ userId, chatId: story.id })
      // The bin holds one item, so this delete evicts the chat for good; the connection's
      // preset is a library entry, not the chat's, so it stays.
      yield* writer.DeleteMessage({ userId, slotId: b.slotId })
      assert.deepStrictEqual(
        (yield* bin()).map((i) => i.excerpt),
        ["b"]
      )
      const after = yield* reader.GetConnection({ userId, connectionId: connection.id })
      assert.strictEqual(after.presetOverrideRefId, preset.ref.id)

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
  })

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
      const { writer, userId, chat, card, root, b, append } = yield* setup()
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
      // The fork's messages that no other fork shows: "a" and "c", not "root".
      yield* append(root.slotId, "z", true)
      assert.strictEqual((yield* writer.DeleteFork({ userId, forkId: chat.currentForkId! })).byteSize, 2)
      // "root" and "z", the participant join and the initial LCM setting (a copy of the default settings)
      const joined = JSON.stringify({ entity: card.entityId }).length
      assert.strictEqual(
        (yield* writer.DeleteChat({ userId, chatId: chat.id })).byteSize,
        5 + joined + JSON.stringify(newChatLcm(null)).length
      )
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
      db.exec(`INSERT INTO rollout_payloads (rollout_id, context_snapshot_json, transcript_json, sent_context_json)
        VALUES ('r1', '{"a":1}', '["猫"]', '{"messages":[]}')`)
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
      // "oops", {"a":1}, ["猫"], {"messages":[]}, "雨" and the initial LCM setting
      assert.strictEqual(
        (yield* writer.DeleteChat({ userId, chatId: story.id })).byteSize,
        4 + 7 + 7 + 15 + 5 + JSON.stringify(newChatLcm(null)).length
      )
      assert.strictEqual((yield* writer.DeleteEntity({ userId, entityId: card.entityId })).byteSize, entityBytes!.n)
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("pages through items deleted in the same millisecond without skipping any", () => {
    const dir = tempDir("bin")
    return Effect.gen(function* () {
      const { writer, reader, userId, chat, a, b, c } = yield* setup()
      for (const slot of [a, b, c]) yield* writer.DeleteMessage({ userId, slotId: slot.slotId })
      for (const text of ["one", "two", "three"]) {
        const key = composerKey(chat.id, chat.currentForkId)
        const draft = yield* writer.SaveDraft({
          draftId: null,
          expectedSession: null,
          userId,
          key,
          content: text,
          expectedRowVersion: (yield* reader.GetDraft({ userId, key }))?.rowVersion ?? null,
          baseRevision: null
        })
        yield* writer.ClearDraft({
          userId,
          key,
          draftId: draft.id,
          outcome: "discarded",
          expectedRowVersion: draft.rowVersion
        })
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

/** `setup` with inserting, forking and reading by fork (spec/MESSAGE-INSERT.md, unit 5). */
const inserting = (handle = "ana") =>
  Effect.gen(function* () {
    const t = yield* setup(handle)
    const { writer, reader, userId, chat, say } = t
    const main = chat.currentForkId! as ForkId
    const send = (forkId: ForkId, parentSlotId: SlotId | null, content: string) =>
      Effect.map(
        writer.AppendMessage({
          userId,
          chatId: chat.id,
          forkId,
          parentSlotId,
          branch: false,
          version: say(content),
          commitDraft: null
        }),
        (sent) => sent.slotId
      )
    const insert = (forkId: ForkId, anchor: SlotId | null, content: string) =>
      Effect.gen(function* () {
        const rowVersion =
          anchor === null ? 0 : (yield* reader.GetSlot({ userId, slotId: anchor, forkId })).entry.rowVersion
        const made = yield* writer.InsertMessage({
          userId,
          chatId: chat.id,
          forkId,
          anchorSlotId: anchor,
          expectedRowVersion: rowVersion,
          body: { _tag: "Write", speaker: t.card.entityId, content }
        })
        return made.slotId
      })
    const fork = (from: ForkId, at: SlotId | null) =>
      Effect.map(writer.CreateFork({ userId, chatId: chat.id, fromForkId: from, atSlotId: at }), (made) => made.fork.id)
    /** What a fork shows, in display order, without what it deleted. */
    const shows = (forkId: ForkId) =>
      Effect.map(reader.GetPath({ userId, chatId: chat.id, forkId, leafSlotId: null, limit: 500 }), (window) =>
        window.entries.map((e) => e.version.content)
      )
    const forks = () => reader.ListForks({ userId, chatId: chat.id })
    const forkOf = (forkId: ForkId) => Effect.map(forks(), (all) => all.find((f) => f.id === forkId)!)
    const del = (forkId: ForkId, slotId: SlotId) => writer.DeleteMessage({ userId, slotId, forkId })
    return { ...t, main, send, insert, fork, shows, forks, forkOf, del }
  })

/** Columns of a slot and its versions, read straight from the database. */
const slotRow = (dir: string, slotId: SlotId) => {
  const db = new DatabaseSync(databaseFile(dir), { readOnly: true })
  const slot = db.prepare(`SELECT deleted_at, bin_item_id, purged_at FROM slots WHERE id = ?`).get(slotId) as {
    deleted_at: number | null
    bin_item_id: string | null
    purged_at: number | null
  }
  const contents = (
    db.prepare(`SELECT content FROM versions WHERE slot_id = ? ORDER BY ordinal`).all(slotId) as Array<{
      content: string
    }>
  ).map((row) => row.content)
  db.close()
  return { marked: slot.deleted_at !== null, item: slot.bin_item_id, purged: slot.purged_at !== null, contents }
}

describe("the bin with inserted messages (spec/MESSAGE-INSERT.md §3.1)", () => {
  it.live("relocation bumps a plain tip once, and a retained deleted tip only when its gap empties", () =>
    Effect.gen(function* () {
      const t = yield* inserting()
      const before = yield* t.forkOf(t.main)
      yield* t.del(t.main, t.c.slotId)
      const moved = yield* t.forkOf(t.main)
      assert.strictEqual(moved.tipSlotId, t.b.slotId)
      assert.strictEqual(moved.rowVersion, before.rowVersion + 1)
      yield* t.del(t.main, t.a.slotId)
      assert.strictEqual((yield* t.forkOf(t.main)).rowVersion, moved.rowVersion)
      const x = yield* t.insert(t.main, t.b.slotId, "x")
      const placed = yield* t.forkOf(t.main)
      yield* t.del(t.main, t.b.slotId)
      yield* t.del(t.main, t.root.slotId)
      const kept = yield* t.forkOf(t.main)
      assert.strictEqual(kept.tipSlotId, t.b.slotId)
      assert.strictEqual(kept.rowVersion, placed.rowVersion)
      yield* t.del(t.main, x)
      const empty = yield* t.forkOf(t.main)
      assert.strictEqual(empty.tipSlotId, null)
      assert.strictEqual(empty.rowVersion, kept.rowVersion + 1)
    }).pipe(Effect.provide(database()))
  )

  it.live("the composer sends and generates past a deleted tip, including a deleted generating tip", () =>
    Effect.gen(function* () {
      for (const kind of ["message", "generate"] as const) {
        for (const generating of [false, true]) {
          const t = yield* inserting(`${kind}${generating}`)
          if (generating)
            yield* t.writer.AddVersion({
              userId: t.userId,
              slotId: t.c.slotId,
              version: new NewVersion({ ...t.say("unfinished"), status: "generating" }),
              select: true,
              commitDraft: null
            })
          yield* t.insert(t.main, t.c.slotId, "last shown")
          yield* t.del(t.main, t.c.slotId)
          const sent = yield* t.writer.SendOrQueue({
            userId: t.userId,
            chatId: t.chat.id,
            forkId: t.main,
            parentSlotId: t.c.slotId,
            branch: false,
            kind,
            content: "next",
            speakerEntityId: t.card.entityId,
            replySpeakerEntityId: null,
            noReply: true,
            direction: null,
            commitDraft: null
          })
          assert.strictEqual(sent._tag, "Posted")
          assert.deepStrictEqual(yield* t.shows(t.main), [
            "root",
            "a",
            "b",
            "last shown",
            kind === "message" ? "next" : ""
          ])
        }
      }
    }).pipe(Effect.provide(database()))
  )

  it.live("chat previews and bin excerpts use the shown insertion past a deleted anchor", () =>
    Effect.gen(function* () {
      const t = yield* inserting()
      yield* t.insert(t.main, t.c.slotId, "last shown")
      yield* t.del(t.main, t.c.slotId)
      // The composer's cast and a swipe at the display end read state at the deleted anchor.
      yield* t.reader.StateEventsAt({
        userId: t.userId,
        chatId: t.chat.id,
        forkId: t.main,
        slotId: t.c.slotId,
        leafSlotId: t.c.slotId
      })
      const summaries = yield* t.reader.ChatSummaries({ userId: t.userId, chatIds: [t.chat.id] })
      assert.strictEqual(summaries[0]!.last?.text, "last shown")
      assert.strictEqual(summaries[0]!.messages, 5)
      const shell = yield* t.reader.ShellLibrary({ userId: t.userId })
      const sidebar = shell.forks.find((fork) => fork.forkId === t.main)!
      assert.strictEqual(sidebar.preview, "last shown")
      assert.strictEqual(sidebar.messages, 4, "the shell counts shown messages, excluding the deleted anchor")
      const later = yield* t.fork(t.main, t.b.slotId)
      // A second deletion warns about main, whose structural tip is deleted.
      const gone = yield* t.del(later, t.a.slotId)
      const warning = yield* t.reader.BinItemForks({ userId: t.userId, itemIds: [gone.id] })
      assert.strictEqual(warning.find((f) => f.forkId === t.main)!.tipExcerpt, "last shown")
      const branch = yield* t.writer.DeleteFork({ userId: t.userId, forkId: t.main })
      assert.strictEqual(branch.excerpt, "last shown")
    }).pipe(Effect.provide(database()))
  )

  it.live("a purged fork's inherited top insertion cannot retain text or appear in bin warnings", () => {
    const dir = tempDir("bin")
    return Effect.gen(function* () {
      const t = yield* inserting()
      const top = yield* t.insert(t.main, null, "top")
      const later = yield* t.fork(t.main, t.b.slotId)
      const branch = yield* t.writer.DeleteFork({ userId: t.userId, forkId: later })
      yield* t.writer.PurgeBinItem({ userId: t.userId, itemId: branch.id })
      const before = (yield* t.reader.GetSlot({ userId: t.userId, slotId: top, forkId: t.main })).entry.version
      const amended = yield* t.writer.AmendVersion({
        userId: t.userId,
        forkId: t.main,
        versionId: before.id,
        content: "top edited",
        expectedRowVersion: before.rowVersion
      })
      assert.strictEqual(amended.id, before.id, "a purged fork cannot force an amend copy")
      const gone = yield* t.del(t.main, top)
      assert.deepStrictEqual(yield* t.reader.BinItemForks({ userId: t.userId, itemIds: [gone.id] }), [])
      assert.isTrue(slotRow(dir, top).marked)
    }).pipe(Effect.provide(database(dir)))
  })

  it.live(
    "restore, fork deletion, purge and eviction preserve inherited insertions through a deep chain of forks",
    () => {
      const dir = tempDir("bin")
      return Effect.gen(function* () {
        const t = yield* inserting()
        const x = yield* t.insert(t.main, t.a.slotId, "x")
        const top = yield* t.insert(t.main, null, "top")
        let descendant = t.main
        for (let i = 0; i < DEEP; i++) descendant = yield* t.fork(descendant, t.b.slotId)
        const gone = yield* t.del(t.main, x)
        yield* t.writer.RestoreBinItem({ userId: t.userId, itemId: gone.id })
        const branch = yield* t.writer.DeleteFork({ userId: t.userId, forkId: t.main })
        assert.strictEqual(branch.origin.messages, 1)
        assert.strictEqual(branch.byteSize, Buffer.byteLength("c"))
        yield* t.writer.RestoreBinItem({ userId: t.userId, itemId: branch.id })
        const again = yield* t.writer.DeleteFork({ userId: t.userId, forkId: t.main })
        yield* t.writer.PurgeBinItem({ userId: t.userId, itemId: again.id })
        assert.deepStrictEqual(yield* t.shows(descendant), ["top", "root", "a", "x", "b"])
        yield* t.del(descendant, x)
        yield* t.del(descendant, top) // evicts x's item; the intermediate forks retain its text.
        assert.deepStrictEqual(slotRow(dir, x).contents, ["x"])
        assert.deepStrictEqual(slotRow(dir, top).contents, ["top"])
        assert.deepStrictEqual(yield* t.shows(descendant), ["root", "a", "b"])
      }).pipe(
        Effect.provide(database(dir, { deletedItems: 1, deletedBytes: 1e9, recoveredTexts: 10, recoveredBytes: 1e9 }))
      )
    }
  )

  it.live(
    "an inserted message deleted in its fork comes back in its gap, without moving the tip or making a fork",
    () =>
      Effect.gen(function* () {
        const t = yield* inserting()
        const x = yield* t.insert(t.main, t.a.slotId, "x")
        yield* t.insert(t.main, t.a.slotId, "y")
        assert.deepStrictEqual(yield* t.shows(t.main), ["root", "a", "y", "x", "b", "c"])
        const item = yield* t.del(t.main, x)
        assert.deepStrictEqual(yield* t.shows(t.main), ["root", "a", "y", "b", "c"])
        assert.strictEqual((yield* t.forkOf(t.main)).tipSlotId, t.c.slotId)
        yield* t.writer.RestoreBinItem({ userId: t.userId, itemId: item.id })
        assert.deepStrictEqual(yield* t.shows(t.main), ["root", "a", "y", "x", "b", "c"])
        assert.strictEqual((yield* t.forks()).length, 1)
        assert.strictEqual((yield* t.forkOf(t.main)).tipSlotId, t.c.slotId)

        // At the display end, below the tip, and above the first message.
        const end = yield* t.insert(t.main, t.c.slotId, "end")
        const top = yield* t.insert(t.main, null, "top")
        for (const slotId of [end, top]) {
          const gone = yield* t.del(t.main, slotId)
          yield* t.writer.RestoreBinItem({ userId: t.userId, itemId: gone.id })
        }
        assert.deepStrictEqual(yield* t.shows(t.main), ["top", "root", "a", "y", "x", "b", "c", "end"])
        assert.strictEqual((yield* t.forks()).length, 1)
        const after = yield* t.forkOf(t.main)
        assert.deepStrictEqual([after.tipSlotId, after.tipExcerpt], [t.c.slotId, "end"])
      }).pipe(Effect.provide(database()))
  )

  it.live("a deleted message's origin keeps its place as the fork showed it, which insertions move off its depth", () =>
    Effect.gen(function* () {
      const t = yield* inserting()
      const plain = yield* t.del(t.main, t.c.slotId)
      assert.deepStrictEqual([plain.origin.depth, plain.origin.position], [3, 3])
      yield* t.writer.RestoreBinItem({ userId: t.userId, itemId: plain.id })
      const x = yield* t.insert(t.main, t.a.slotId, "x")
      yield* t.insert(t.main, t.a.slotId, "y")
      assert.deepStrictEqual(yield* t.shows(t.main), ["root", "a", "y", "x", "b", "c"])
      const inserted = yield* t.del(t.main, x)
      assert.deepStrictEqual([inserted.origin.depth, inserted.origin.position], [2, 3])
      const below = yield* t.del(t.main, t.c.slotId)
      // A deleted message keeps its number, as with depths: c is still sixth, after root, a, y, x, b.
      assert.deepStrictEqual([below.origin.depth, below.origin.position], [3, 5])
    }).pipe(Effect.provide(database()))
  )

  it.live("an inserted message restored after its anchor left the fork's path comes back as a fork of its own", () =>
    Effect.gen(function* () {
      const t = yield* inserting()
      const x = yield* t.insert(t.main, t.b.slotId, "x")
      const item = yield* t.del(t.main, x)
      yield* t.del(t.main, t.c.slotId)
      yield* t.del(t.main, t.b.slotId)
      assert.strictEqual((yield* t.forkOf(t.main)).tipSlotId, t.a.slotId)
      yield* t.writer.RestoreBinItem({ userId: t.userId, itemId: item.id })
      assert.deepStrictEqual(yield* t.shows(t.main), ["root", "a"])
      const made = (yield* t.forks()).find((f) => f.id !== t.main)!
      assert.deepStrictEqual([made.baseSlotId, made.tipSlotId], [t.b.slotId, x])
      assert.deepStrictEqual(yield* t.shows(made.id), ["root", "a", "x"])
    }).pipe(Effect.provide(database()))
  )

  it.live("purging an inserted message names the later fork that inherits it, and erases it there too", () => {
    const dir = tempDir("bin")
    return Effect.gen(function* () {
      const t = yield* inserting()
      const before = yield* t.fork(t.main, t.b.slotId)
      const x = yield* t.insert(t.main, t.a.slotId, "x")
      const later = yield* t.fork(t.main, t.b.slotId)
      assert.deepStrictEqual(yield* t.shows(later), ["root", "a", "x", "b"])
      const item = yield* t.del(t.main, x)
      assert.deepStrictEqual(yield* t.shows(t.main), ["root", "a", "b", "c"])
      assert.deepStrictEqual(yield* t.shows(later), ["root", "a", "x", "b"])
      assert.deepStrictEqual(yield* t.shows(before), ["root", "a", "b"])
      // Another fork shows it, so it isn't marked; the warning names that fork alone.
      assert.isFalse(slotRow(dir, x).marked)
      const named = yield* t.reader.BinItemForks({ userId: t.userId, itemIds: [item.id] })
      assert.deepStrictEqual(
        named.map((f) => f.forkId),
        [later]
      )
      const stale = yield* t.writer
        .PurgeBinItem({ userId: t.userId, itemId: item.id, expectedForkIds: [] })
        .pipe(Effect.flip)
      assert.strictEqual(stale._tag, "BinChanged")
      yield* t.writer.PurgeBinItem({ userId: t.userId, itemId: item.id, expectedForkIds: [later] })
      assert.deepStrictEqual(yield* t.shows(later), ["root", "a", "b"])
      assert.deepStrictEqual(yield* t.shows(t.main), ["root", "a", "b", "c"])
      const row = slotRow(dir, x)
      assert.deepStrictEqual([row.marked, row.purged, row.contents], [true, true, [""]])
      assert.deepStrictEqual(yield* t.bin(), [])
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("making room in the bin never erases an inserted message a later fork inherits", () => {
    const dir = tempDir("bin")
    return Effect.gen(function* () {
      const t = yield* inserting()
      const x = yield* t.insert(t.main, t.a.slotId, "x")
      const later = yield* t.fork(t.main, t.b.slotId)
      yield* t.del(t.main, x)
      // The one-item bin evicts x's item: its deletion in main stays, and `later` keeps it.
      yield* t.del(t.main, t.c.slotId)
      assert.deepStrictEqual(
        (yield* t.bin()).map((i) => i.excerpt),
        ["c"]
      )
      assert.deepStrictEqual(yield* t.shows(later), ["root", "a", "x", "b"])
      assert.deepStrictEqual(yield* t.shows(t.main), ["root", "a", "b"])
      assert.deepStrictEqual(slotRow(dir, x).contents, ["x"])
    }).pipe(
      Effect.provide(database(dir, { deletedItems: 1, deletedBytes: 1e9, recoveredTexts: 10, recoveredBytes: 1e9 }))
    )
  })

  it.live("deleting the fork that inserted a message keeps it for a descendant that shows it", () => {
    const dir = tempDir("bin")
    return Effect.gen(function* () {
      const t = yield* inserting()
      const x = yield* t.insert(t.main, t.a.slotId, "x")
      const later = yield* t.fork(t.main, t.b.slotId)
      const item = yield* t.writer.DeleteFork({ userId: t.userId, forkId: t.main })
      // Only c is main's alone: b and x are shown by `later`.
      assert.strictEqual(item.origin.messages, 1)
      assert.isFalse(slotRow(dir, x).marked)
      assert.isTrue(slotRow(dir, t.c.slotId).marked)
      yield* t.writer.PurgeBinItem({ userId: t.userId, itemId: item.id })
      assert.deepStrictEqual(yield* t.shows(later), ["root", "a", "x", "b"])
      assert.deepStrictEqual(slotRow(dir, x).contents, ["x"])
      assert.deepStrictEqual(slotRow(dir, t.c.slotId).contents, [""])
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("deleting a fork marks the inserted messages no other fork shows, and restoring it brings them back", () => {
    const dir = tempDir("bin")
    return Effect.gen(function* () {
      const t = yield* inserting()
      const before = yield* t.fork(t.main, t.b.slotId)
      const x = yield* t.insert(t.main, t.a.slotId, "x")
      const top = yield* t.insert(t.main, null, "top")
      const item = yield* t.writer.DeleteFork({ userId: t.userId, forkId: t.main })
      // c, x and top: `before` was made before the insertions.
      assert.strictEqual(item.origin.messages, 3)
      assert.strictEqual(item.byteSize, Buffer.byteLength("cxtop"))
      assert.strictEqual(item.title, 'Fork of 3 messages in "Harbor"')
      for (const slotId of [x, top, t.c.slotId]) assert.strictEqual(slotRow(dir, slotId).item, item.id)
      assert.deepStrictEqual(yield* t.shows(before), ["root", "a", "b"])
      yield* t.writer.RestoreBinItem({ userId: t.userId, itemId: item.id })
      assert.deepStrictEqual(yield* t.shows(t.main), ["top", "root", "a", "x", "b", "c"])
      for (const slotId of [x, top]) assert.isFalse(slotRow(dir, slotId).marked)

      const again = yield* t.writer.DeleteFork({ userId: t.userId, forkId: t.main })
      yield* t.writer.PurgeBinItem({ userId: t.userId, itemId: again.id })
      for (const slotId of [x, top]) assert.deepStrictEqual(slotRow(dir, slotId).contents, [""])
      assert.deepStrictEqual(yield* t.shows(before), ["root", "a", "b"])
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("deleting a fork made at an inserted message keeps that message for the fork that inserted it", () => {
    const dir = tempDir("bin")
    return Effect.gen(function* () {
      const t = yield* inserting()
      const x = yield* t.insert(t.main, t.a.slotId, "x")
      const atX = yield* t.fork(t.main, x)
      yield* t.writer.AddVersion({
        userId: t.userId,
        slotId: x,
        forkId: atX,
        version: t.say("another shared swipe"),
        select: false,
        commitDraft: null
      })
      const e = yield* t.send(atX, x, "e")
      assert.deepStrictEqual(yield* t.shows(atX), ["root", "a", "x", "e"])
      const item = yield* t.writer.DeleteFork({ userId: t.userId, forkId: atX })
      // x is on its structural path, past what it shares with main, but main shows it.
      assert.strictEqual(item.origin.messages, 1)
      assert.strictEqual(item.byteSize, Buffer.byteLength("e"))
      assert.isFalse(slotRow(dir, x).marked)
      yield* t.writer.PurgeBinItem({ userId: t.userId, itemId: item.id })
      assert.deepStrictEqual(yield* t.shows(t.main), ["root", "a", "x", "b", "c"])
      assert.deepStrictEqual(slotRow(dir, e).contents, [""])
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("deleting an anchor keeps the messages inserted below it, the fork's tip included", () =>
    Effect.gen(function* () {
      const t = yield* inserting()
      // In the middle: its gap stays where it was.
      yield* t.insert(t.main, t.a.slotId, "x")
      const a = yield* t.del(t.main, t.a.slotId)
      assert.deepStrictEqual(yield* t.shows(t.main), ["root", "x", "b", "c"])
      yield* t.writer.RestoreBinItem({ userId: t.userId, itemId: a.id })
      assert.deepStrictEqual(yield* t.shows(t.main), ["root", "a", "x", "b", "c"])

      // At the tip: the tip stays on it while its gap holds a message the fork shows.
      const z = yield* t.insert(t.main, t.c.slotId, "z")
      const c = yield* t.del(t.main, t.c.slotId)
      assert.deepStrictEqual(yield* t.shows(t.main), ["root", "a", "x", "b", "z"])
      const tip = yield* t.forkOf(t.main)
      assert.deepStrictEqual([tip.tipSlotId, tip.tipExcerpt], [t.c.slotId, "z"])
      yield* t.writer.RestoreBinItem({ userId: t.userId, itemId: c.id })
      assert.deepStrictEqual(yield* t.shows(t.main), ["root", "a", "x", "b", "c", "z"])
      assert.strictEqual((yield* t.forks()).length, 1)
      const d = yield* t.send(t.main, t.c.slotId, "d")
      assert.deepStrictEqual(yield* t.shows(t.main), ["root", "a", "x", "b", "c", "z", "d"])

      // Appending while the tip is deleted goes below it, after its gap.
      yield* t.del(t.main, d)
      assert.strictEqual((yield* t.forkOf(t.main)).tipSlotId, t.c.slotId)
      yield* t.del(t.main, t.c.slotId)
      const e = yield* t.send(t.main, t.c.slotId, "e")
      assert.deepStrictEqual(yield* t.shows(t.main), ["root", "a", "x", "b", "z", "e"])
      // Deleting e brings the tip back to c, which still holds z; deleting z frees it.
      yield* t.del(t.main, e)
      assert.strictEqual((yield* t.forkOf(t.main)).tipSlotId, t.c.slotId)
      yield* t.del(t.main, z)
      assert.strictEqual((yield* t.forkOf(t.main)).tipSlotId, t.b.slotId)
      assert.deepStrictEqual(yield* t.shows(t.main), ["root", "a", "x", "b"])
    }).pipe(Effect.provide(database()))
  )

  it.live("a deleted inserted message's own gap keeps a deleted tip in place", () =>
    Effect.gen(function* () {
      const t = yield* inserting()
      const x = yield* t.insert(t.main, t.c.slotId, "x")
      yield* t.insert(t.main, x, "y")
      yield* t.del(t.main, x)
      yield* t.del(t.main, t.c.slotId)
      assert.deepStrictEqual(yield* t.shows(t.main), ["root", "a", "b", "y"])
      assert.strictEqual((yield* t.forkOf(t.main)).tipSlotId, t.c.slotId)
    }).pipe(Effect.provide(database()))
  )

  // Against a list oracle: a fork is a list of messages, deleted ones flagged. Appending adds
  // at its end, inserting below P directly after P (above the first message, at its start), a
  // fork made at P starts as its parent's list up to P, and deleting any message, the tip
  // included, hides it alone. Every fork must show its list after every step.
  it.live(
    "keeps every fork's view as a list of what it shows under random appends, insertions, forks and deletions",
    () =>
      Effect.gen(function* () {
        for (const seed of [1, 2, 3, 4, 5, 6]) {
          const t = yield* inserting(`seed${seed}`)
          let state = seed
          const pick = (n: number) => {
            state = (state * 1103515245 + 12345) % 2147483648
            return state % n
          }
          const text = new Map<string, string>([
            [t.root.slotId, "root"],
            [t.a.slotId, "a"],
            [t.b.slotId, "b"],
            [t.c.slotId, "c"]
          ])
          type Model = { list: Array<SlotId>; deleted: Set<SlotId> }
          const models = new Map<ForkId, Model>([
            [t.main, { list: [t.root.slotId, t.a.slotId, t.b.slotId, t.c.slotId], deleted: new Set() }]
          ])
          const visible = (model: Model) => model.list.filter((id) => !model.deleted.has(id))
          for (let step = 0; step < 40; step++) {
            const forkIds = [...models.keys()]
            const forkId = forkIds[pick(forkIds.length)]!
            const model = models.get(forkId)!
            const shown = visible(model)
            const label = `s${seed}.${step}`
            const op = pick(10)
            if (op < 3 || shown.length === 0) {
              const tip = (yield* t.forkOf(forkId)).tipSlotId
              const id = yield* t.send(forkId, tip, label)
              text.set(id, label)
              model.list.push(id)
            } else if (op < 6) {
              const at = pick(shown.length + 1)
              const anchor = at === shown.length ? null : shown[at]!
              const id = yield* t.insert(forkId, anchor, label)
              text.set(id, label)
              model.list.splice(anchor === null ? 0 : model.list.indexOf(anchor) + 1, 0, id)
            } else if (op < 8) {
              const at = shown[pick(shown.length)]!
              const made = yield* t.fork(forkId, at)
              models.set(made, {
                list: model.list.slice(0, model.list.indexOf(at) + 1),
                deleted: new Set(model.deleted)
              })
            } else {
              const id = shown[pick(shown.length)]!
              yield* t.del(forkId, id)
              model.deleted.add(id)
            }
            for (const [id, each] of models) {
              assert.deepStrictEqual(
                yield* t.shows(id),
                visible(each).map((slotId) => text.get(slotId)),
                `seed ${seed}, step ${step}, fork ${id}`
              )
            }
          }
        }
      }).pipe(Effect.provide(database())),
    { timeout: 120_000, tags: ["slow"] }
  )
})
