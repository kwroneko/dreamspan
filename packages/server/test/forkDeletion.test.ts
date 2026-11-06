// Deleting and hiding per fork (spec/FORK-INDEPENDENCE-DELTA.md §2.4, implementation unit 5): what a
// user deletes or hides in one fork never changes another, a deleted fork takes only itself (owner,
// 2026-10-27, Q2), and deleting for good erases the text everywhere, after the forks that show it
// were named (Q3). The migration is in forkDeletionMigration.test.ts.
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import type { BinLimits } from "@rp/shared/bin.ts"
import { type ChatId, type ForkId, NewVersion, type SlotId, type VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { databaseFile } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { historyRevision } from "../src/db/historyChanges.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { tempDir } from "./support/tempDir.ts"
import { cardDoc } from "./support/docs.ts"
import { testWorkers } from "./support/bundles.ts"

/** A chain of forks deeper than tests otherwise make: fork labels have no cap. */
const DEEP = 70

const NOW = Date.UTC(2026, 0, 1)

const database = (dataDir: string, binLimits?: BinLimits) =>
  Database.layer({
    dataDir,
    readers: 2,
    allowNetworkFs: false,
    ...testWorkers,
    ...(binLimits ? { binLimits } : {})
  })

/**
 * A chat `root → h1 → a1 → h2` in its first fork, `main`, with a second fork `side` made at `a1` that
 * went on to `g1`, and helpers. a1 has a second swipe, "a1 again", unselected.
 */
const setup = (dir: string) =>
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "ana" })).id as UserId
    const mira = (yield* writer.CreateEntity({
      userId,
      kind: "card",
      label: "Mira",
      subtitle: "",
      doc: cardDoc("Mira"),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })).entityId
    const chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "Harbor",
      participants: [mira],
      greeting: null
    })
    const chatId = chat.id as ChatId
    const main = chat.currentForkId as ForkId
    const say = (content: string, status: "complete" | "generating" = "complete", as: "human" | "model" = "model") =>
      new NewVersion({
        speakerEntityId: as === "model" ? mira : null,
        writer: as,
        content,
        status,
        macroMode: "verbatim",
        origin: as === "human" ? "user_written" : "generated"
      })
    const append = (forkId: ForkId, parent: SlotId | null, content: string, as: "human" | "model" = "model") =>
      writer.AppendMessage({
        userId,
        chatId,
        forkId,
        parentSlotId: parent,
        branch: false,
        version: say(content, "complete", as),
        commitDraft: null
      })
    const root = yield* append(main, null, "root")
    const h1 = yield* append(main, root.slotId, "h1", "human")
    const a1 = yield* append(main, h1.slotId, "a1")
    const again = yield* writer.AddVersion({
      userId,
      slotId: a1.slotId,
      version: say("a1 again"),
      select: false,
      commitDraft: null
    })
    const h2 = yield* append(main, a1.slotId, "h2", "human")
    const side = (yield* writer.CreateFork({ userId, chatId, fromForkId: main, atSlotId: a1.slotId })).fork.id as ForkId
    const g1 = yield* append(side, a1.slotId, "g1", "human")
    const texts = (forkId: ForkId) =>
      Effect.map(reader.GetPath({ userId, chatId, forkId, leafSlotId: null, limit: 100 }), (path) =>
        path.entries.map((e) => e.version.content).filter((content) => content !== "")
      )
    const forks = Effect.map(reader.ListForks({ userId, chatId }), (list) => list.map((f) => f.id))
    const bin = reader.ListBin({ userId, limit: 100, before: null })
    const rows = (sql: string, ...params: Array<string | number | null>) =>
      Effect.map(fixtureSql(dir, [{ sql, params }], { readOnly: true }), ([result]) => result!)
    /** The model's context in a fork: a reply is asked for at its tip, and what the assembler read before it. */
    const context = (forkId: ForkId) =>
      Effect.gen(function* () {
        const tip = (yield* reader.ListForks({ userId, chatId })).find((f) => f.id === forkId)!.tipSlotId
        const asked = yield* writer.AppendMessage({
          userId,
          chatId,
          forkId,
          parentSlotId: tip,
          branch: false,
          version: say("", "generating"),
          commitDraft: null
        })
        const { snapshot } = yield* reader.AssembleContext({
          userId,
          chatId,
          slotId: asked.slotId,
          versionId: asked.version.id,
          now: NOW,
          timeZone: "UTC",
          frozen: null
        })
        const messages = (JSON.parse(snapshot) as { request: { messages: Array<{ content: string }> } }).request
          .messages
        return messages.map((m) => m.content).filter((c) => /^(root|h1|a1|h2|g1|a1 again)$/.test(c))
      })
    return {
      writer,
      reader,
      userId,
      chatId,
      main,
      side,
      root,
      h1,
      a1,
      again: again.id as VersionId,
      h2,
      g1,
      append,
      say,
      texts,
      forks,
      bin,
      rows,
      context
    }
  })

describe("deleting in a fork", () => {
  it.live("a message deleted in one fork stays in the other, in the path, the picker and the context", () => {
    const dir = tempDir("fork-deletion")
    return Effect.gen(function* () {
      const { writer, reader, userId, main, side, a1, texts, bin, rows, context } = yield* setup(dir)
      const item = yield* writer.DeleteMessage({ userId, slotId: a1.slotId, forkId: main })
      assert.deepStrictEqual(yield* texts(main), ["root", "h1", "h2"])
      assert.deepStrictEqual(yield* texts(side), ["root", "h1", "a1", "g1"])
      assert.deepStrictEqual(yield* context(main), ["root", "h1", "h2"])
      assert.deepStrictEqual(yield* context(side), ["root", "h1", "a1", "g1"])
      // The other fork's picker still has both swipes; the deleting fork's message is gone.
      assert.deepStrictEqual(
        (yield* reader.ListVersions({ userId, slotId: a1.slotId, forkId: side })).map((v) => v.content),
        ["a1", "a1 again"]
      )
      assert.strictEqual(
        (yield* reader.GetSlot({ userId, slotId: a1.slotId, forkId: side }).pipe(Effect.option))._tag,
        "Some"
      )
      assert.strictEqual(
        (yield* reader.GetSlot({ userId, slotId: a1.slotId, forkId: main }).pipe(Effect.flip))._tag,
        "NotFound"
      )
      // Nothing was written on the shared slot, and the item names its fork.
      assert.deepStrictEqual((yield* rows(`SELECT deleted_at, bin_item_id FROM slots WHERE id = ?`, a1.slotId))[0], {
        deleted_at: null,
        bin_item_id: null
      })
      const [listed] = yield* bin
      assert.strictEqual(listed!.origin.forkId, main)
      yield* writer.RestoreBinItem({ userId, itemId: item.id })
      assert.deepStrictEqual(yield* texts(main), ["root", "h1", "a1", "h2"])
      assert.deepStrictEqual(yield* texts(side), ["root", "h1", "a1", "g1"])
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("a message no other fork shows is marked too, so it leaves the alternates", () => {
    const dir = tempDir("fork-deletion")
    return Effect.gen(function* () {
      const { writer, userId, main, side, h2, texts, rows } = yield* setup(dir)
      const item = yield* writer.DeleteMessage({ userId, slotId: h2.slotId, forkId: main })
      const [marked] = yield* rows(`SELECT bin_item_id FROM slots WHERE id = ?`, h2.slotId)
      assert.strictEqual(marked!.bin_item_id, item.id)
      // The fork's tip went up, and the other fork's didn't.
      assert.deepStrictEqual(yield* texts(main), ["root", "h1", "a1"])
      assert.deepStrictEqual(yield* texts(side), ["root", "h1", "a1", "g1"])
      yield* writer.RestoreBinItem({ userId, itemId: item.id })
      assert.deepStrictEqual(yield* texts(main), ["root", "h1", "a1", "h2"])
      assert.deepStrictEqual((yield* rows(`SELECT deleted_at FROM slots WHERE id = ?`, h2.slotId))[0], {
        deleted_at: null
      })
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("restoring a message after its fork went on makes a fork of its own", () => {
    const dir = tempDir("fork-deletion")
    return Effect.gen(function* () {
      const { writer, reader, userId, chatId, main, a1, h2, texts, append } = yield* setup(dir)
      // The message at the end of the fork goes, the fork goes on, and the message comes back.
      const item = yield* writer.DeleteMessage({ userId, slotId: h2.slotId, forkId: main })
      assert.deepStrictEqual(yield* texts(main), ["root", "h1", "a1"])
      yield* append(main, a1.slotId, "z")
      const before = yield* reader.ListForks({ userId, chatId })
      yield* writer.RestoreBinItem({ userId, itemId: item.id })
      assert.deepStrictEqual(yield* texts(main), ["root", "h1", "a1", "z"])
      const made = (yield* reader.ListForks({ userId, chatId })).filter((f) => !before.some((b) => b.id === f.id))
      assert.lengthOf(made, 1)
      assert.deepStrictEqual(yield* texts(made[0]!.id), ["root", "h1", "a1", "h2"])
      // It's an ordinary fork, and the fork chatted in last stays the current one.
      assert.strictEqual((yield* reader.GetChat({ userId, chatId })).currentForkId, main)
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("restoring a message the fork's tip went up from brings the tip back down", () => {
    const dir = tempDir("fork-deletion")
    return Effect.gen(function* () {
      const { writer, reader, userId, chatId, main, h2, texts } = yield* setup(dir)
      const item = yield* writer.DeleteMessage({ userId, slotId: h2.slotId, forkId: main })
      const before = yield* reader.ListForks({ userId, chatId })
      yield* writer.RestoreBinItem({ userId, itemId: item.id })
      assert.deepStrictEqual(yield* texts(main), ["root", "h1", "a1", "h2"])
      assert.lengthOf(yield* reader.ListForks({ userId, chatId }), before.length)
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("a swipe deleted in one fork stays in the other fork's picker, and each fork reselects alone", () => {
    const dir = tempDir("fork-deletion")
    return Effect.gen(function* () {
      const { writer, reader, userId, main, side, a1, again, texts } = yield* setup(dir)
      yield* writer.SelectVersion({
        userId,
        slotId: a1.slotId,
        versionId: again,
        forkId: side,
        expectedVersionId: a1.version.id
      })
      const item = yield* writer.DeleteVersion({ userId, versionId: a1.version.id, forkId: main })
      // `main` showed the first swipe, so it shows the next; `side` showed the second, and keeps it.
      assert.deepStrictEqual(yield* texts(main), ["root", "h1", "a1 again", "h2"])
      assert.deepStrictEqual(yield* texts(side), ["root", "h1", "a1 again", "g1"])
      const picker = (forkId: ForkId) =>
        Effect.map(reader.ListVersions({ userId, slotId: a1.slotId, forkId }), (v) => v.map((x) => x.content))
      assert.deepStrictEqual(yield* picker(main), ["a1 again"])
      assert.deepStrictEqual(yield* picker(side), ["a1", "a1 again"])
      yield* writer.RestoreBinItem({ userId, itemId: item.id })
      assert.deepStrictEqual(yield* picker(main), ["a1", "a1 again"])
      assert.deepStrictEqual(yield* texts(main), ["root", "h1", "a1 again", "h2"])
    }).pipe(Effect.provide(database(dir)))
  })
})

describe("deleting a fork", () => {
  it.live("only that fork goes: a fork made from it keeps its shared history, and Restore brings it back", () => {
    const dir = tempDir("fork-deletion")
    return Effect.gen(function* () {
      const { writer, reader, userId, chatId, main, side, texts, forks, rows, h2 } = yield* setup(dir)
      const item = yield* writer.DeleteFork({ userId, forkId: main })
      assert.deepStrictEqual(yield* forks, [side])
      assert.deepStrictEqual(yield* texts(side), ["root", "h1", "a1", "g1"])
      assert.strictEqual((yield* reader.GetChat({ userId, chatId })).currentForkId, side)
      // Only what no other fork shows is marked: h2, not the messages `side` has.
      assert.deepStrictEqual(
        (yield* rows(`SELECT id FROM slots WHERE bin_item_id = ?`, item.id)).map((r) => r.id),
        [h2.slotId]
      )
      assert.strictEqual(item.origin.forkId, main)
      yield* writer.RestoreBinItem({ userId, itemId: item.id })
      assert.sameMembers(yield* forks, [main, side])
      assert.deepStrictEqual(yield* texts(main), ["root", "h1", "a1", "h2"])
      assert.strictEqual((yield* reader.GetChat({ userId, chatId })).currentForkId, side)
      assert.deepStrictEqual((yield* rows(`SELECT count(*) AS n FROM slots WHERE deleted_at IS NOT NULL`))[0], { n: 0 })
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("a fork made from the deleted fork's own messages keeps them, and deleting for good spares them", () => {
    const dir = tempDir("fork-deletion")
    return Effect.gen(function* () {
      const { writer, userId, chatId, main, h2, append, texts, rows } = yield* setup(dir)
      // A fork made at h2, a message only `main` had until now.
      const later = (yield* writer.CreateFork({ userId, chatId, fromForkId: main, atSlotId: h2.slotId })).fork
        .id as ForkId
      yield* append(later, h2.slotId, "x1")
      const item = yield* writer.DeleteFork({ userId, forkId: main })
      assert.deepStrictEqual(yield* texts(later), ["root", "h1", "a1", "h2", "x1"])
      assert.deepStrictEqual((yield* rows(`SELECT count(*) AS n FROM slots WHERE bin_item_id = ?`, item.id))[0], {
        n: 0
      })
      yield* writer.PurgeBinItem({ userId, itemId: item.id })
      assert.deepStrictEqual(yield* texts(later), ["root", "h1", "a1", "h2", "x1"])
      // The purged fork's row stays for the forks made from it, without name or tip.
      assert.deepStrictEqual(
        (yield* rows(`SELECT purged_at IS NOT NULL AS purged, tip_slot_id FROM forks WHERE id = ?`, main))[0],
        { purged: 1, tip_slot_id: null }
      )
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("a chat's last live fork isn't deleted", () => {
    const dir = tempDir("fork-deletion")
    return Effect.gen(function* () {
      const { writer, userId, main, side } = yield* setup(dir)
      yield* writer.DeleteFork({ userId, forkId: side })
      assert.strictEqual(
        (yield* writer.DeleteFork({ userId, forkId: main }).pipe(Effect.flip))._tag,
        "CannotDeleteLastFork"
      )
    }).pipe(Effect.provide(database(dir)))
  })
})

describe("deleting for good", () => {
  it.live("erases the text in every fork, after naming the forks that show it", () => {
    const dir = tempDir("fork-deletion")
    return Effect.gen(function* () {
      const { writer, reader, userId, main, side, a1, texts, forks, rows } = yield* setup(dir)
      yield* writer.SetForkName({ userId, forkId: side, name: "Side road" })
      const item = yield* writer.DeleteMessage({ userId, slotId: a1.slotId, forkId: main })
      // The warning: the forks other than the one that deleted it that still show it.
      const shown = yield* reader.BinItemForks({ userId, itemIds: [item.id] })
      assert.deepStrictEqual(
        shown.map((s) => [s.itemId, s.forkId, s.name]),
        [[item.id, side, "Side road"]]
      )
      yield* writer.PurgeBinItem({ userId, itemId: item.id })
      assert.deepStrictEqual(yield* texts(side), ["root", "h1", "g1"])
      assert.deepStrictEqual(yield* texts(main), ["root", "h1", "h2"])
      assert.deepStrictEqual(
        (yield* rows(`SELECT content FROM versions WHERE slot_id = ? ORDER BY ordinal`, a1.slotId)).map(
          (r) => r.content
        ),
        ["", ""]
      )
      assert.sameMembers(yield* forks, [main, side])
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("a swipe goes from every fork: the ones that showed it show another", () => {
    const dir = tempDir("fork-deletion")
    return Effect.gen(function* () {
      const { writer, reader, userId, main, side, a1, again, texts, rows } = yield* setup(dir)
      yield* writer.SelectVersion({
        userId,
        slotId: a1.slotId,
        versionId: again,
        forkId: side,
        expectedVersionId: a1.version.id
      })
      const item = yield* writer.DeleteVersion({ userId, versionId: again, forkId: main })
      const shown = yield* reader.BinItemForks({ userId, itemIds: [item.id] })
      assert.deepStrictEqual(
        shown.map((s) => s.forkId),
        [side]
      )
      yield* writer.PurgeBinItem({ userId, itemId: item.id })
      assert.deepStrictEqual(yield* texts(side), ["root", "h1", "a1", "g1"])
      assert.deepStrictEqual((yield* rows(`SELECT content FROM versions WHERE id = ?`, again))[0], { content: "" })
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("making room never erases what another fork shows", () => {
    const dir = tempDir("fork-deletion")
    return Effect.gen(function* () {
      const { writer, userId, main, side, a1, h2, texts, bin } = yield* setup(dir)
      // Room for one item: the second delete makes the bin evict the first.
      yield* writer.DeleteMessage({ userId, slotId: a1.slotId, forkId: main })
      yield* writer.DeleteMessage({ userId, slotId: h2.slotId, forkId: main })
      assert.lengthOf(yield* bin, 1)
      assert.deepStrictEqual(yield* texts(side), ["root", "h1", "a1", "g1"])
    }).pipe(
      Effect.provide(database(dir, { deletedItems: 1, deletedBytes: 1e9, recoveredTexts: 10, recoveredBytes: 1e9 }))
    )
  })
})

describe("hiding in a fork", () => {
  it.live("a message hidden in one fork is still sent in the other, and stepped history follows", () => {
    const dir = tempDir("fork-deletion")
    return Effect.gen(function* () {
      const { writer, reader, userId, chatId, main, side, h1, h2, g1, texts, context } = yield* setup(dir)
      assert.deepStrictEqual(yield* writer.SetSlotHidden({ userId, slotId: h1.slotId, forkId: main, hidden: true }), {
        changed: true
      })
      assert.deepStrictEqual(yield* writer.SetSlotHidden({ userId, slotId: h1.slotId, forkId: main, hidden: true }), {
        changed: false
      })
      const hidden = (forkId: ForkId) =>
        Effect.map(
          reader.GetPath({ userId, chatId, forkId, leafSlotId: null, limit: 100 }),
          (path) => path.entries.find((e) => e.slotId === h1.slotId)!.contextExcluded
        )
      assert.isTrue(yield* hidden(main))
      assert.isFalse(yield* hidden(side))
      assert.deepStrictEqual(yield* texts(side), ["root", "h1", "a1", "g1"])
      assert.deepStrictEqual(yield* context(main), ["root", "a1", "h2"])
      assert.deepStrictEqual(yield* context(side), ["root", "h1", "a1", "g1"])
      // The reduction counts in the fork that hid the message, and in forks made from it after.
      const revision = (forkId: ForkId, leaf: SlotId, before: number) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const [row] = yield* historyRevision(sql, userId, chatId, leaf, before, forkId)
          return row!.revision
        }).pipe(Effect.provide(SqliteClient.layer({ filename: databaseFile(dir), readonly: true })))
      assert.strictEqual(yield* revision(main, h2.slotId, 10), 1)
      assert.strictEqual(yield* revision(side, g1.slotId, 10), 0)
      const later = (yield* writer.CreateFork({ userId, chatId, fromForkId: main, atSlotId: h2.slotId })).fork
        .id as ForkId
      assert.strictEqual(yield* revision(later, h2.slotId, 10), 1)
      // Showing it again: the other fork was never touched.
      yield* writer.SetSlotHidden({ userId, slotId: h1.slotId, forkId: main, hidden: false })
      assert.isFalse(yield* hidden(main))
    }).pipe(Effect.provide(database(dir)))
  })
})

describe("fork deletion review regressions", () => {
  it.live("a deleted fork is named before erasing a message it will show on restore", () => {
    const dir = tempDir("fork-deletion-review")
    return Effect.gen(function* () {
      const { writer, reader, userId, main, side, a1 } = yield* setup(dir)
      yield* writer.DeleteFork({ userId, forkId: side })
      const item = yield* writer.DeleteMessage({ userId, slotId: a1.slotId, forkId: main })
      assert.deepStrictEqual(
        (yield* reader.BinItemForks({ userId, itemIds: [item.id] })).map((f) => f.forkId),
        [side]
      )
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("purging a parent fork keeps the history of its deleted descendant", () => {
    const dir = tempDir("fork-deletion-review")
    return Effect.gen(function* () {
      const { writer, userId, chatId, main, side, h2, texts } = yield* setup(dir)
      const child = (yield* writer.CreateFork({ userId, chatId, fromForkId: main, atSlotId: h2.slotId })).fork.id
      const childItem = yield* writer.DeleteFork({ userId, forkId: child })
      const parentItem = yield* writer.DeleteFork({ userId, forkId: main })
      yield* writer.PurgeBinItem({ userId, itemId: parentItem.id })
      yield* writer.RestoreBinItem({ userId, itemId: childItem.id })
      assert.deepStrictEqual(yield* texts(child), ["root", "h1", "a1", "h2"])
      assert.deepStrictEqual(yield* texts(side), ["root", "h1", "a1", "g1"])
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("restoring a tip never follows another fork's replies", () => {
    const dir = tempDir("fork-deletion-review")
    return Effect.gen(function* () {
      const { writer, userId, chatId, main, h2, texts, append } = yield* setup(dir)
      const child = (yield* writer.CreateFork({ userId, chatId, fromForkId: main, atSlotId: h2.slotId })).fork.id
      yield* append(child, h2.slotId, "child only")
      const item = yield* writer.DeleteMessage({ userId, slotId: h2.slotId, forkId: main })
      yield* writer.RestoreBinItem({ userId, itemId: item.id })
      assert.deepStrictEqual(yield* texts(main), ["root", "h1", "a1", "h2"])
      assert.deepStrictEqual(yield* texts(child), ["root", "h1", "a1", "h2", "child only"])
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("automatic eviction keeps a swipe deleted locally in another fork available there for restore", () => {
    const dir = tempDir("fork-deletion-review")
    return Effect.gen(function* () {
      const { writer, userId, main, side, again, h2, rows } = yield* setup(dir)
      yield* writer.DeleteVersion({ userId, versionId: again, forkId: main })
      const sideItem = yield* writer.DeleteVersion({ userId, versionId: again, forkId: side })
      yield* writer.DeleteMessage({ userId, slotId: h2.slotId, forkId: main })
      yield* writer.RestoreBinItem({ userId, itemId: sideItem.id })
      assert.deepStrictEqual((yield* rows("SELECT content FROM versions WHERE id = ?", again))[0], {
        content: "a1 again"
      })
    }).pipe(
      Effect.provide(database(dir, { deletedItems: 2, deletedBytes: 1e9, recoveredTexts: 10, recoveredBytes: 1e9 }))
    )
  })

  it.live("later reductions in the parent preserve a child's inherited history revision", () => {
    const dir = tempDir("fork-deletion-review")
    return Effect.gen(function* () {
      const { writer, userId, chatId, main, h1, h2 } = yield* setup(dir)
      yield* writer.SetSlotHidden({ userId, slotId: h1.slotId, forkId: main, hidden: true })
      const child = (yield* writer.CreateFork({ userId, chatId, fromForkId: main, atSlotId: h2.slotId })).fork.id
      const revision = () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return (yield* historyRevision(sql, userId, chatId, h2.slotId, 10, child))[0]!.revision
        }).pipe(Effect.provide(SqliteClient.layer({ filename: databaseFile(dir), readonly: true })))
      const before = yield* revision()
      yield* writer.SetSlotHidden({ userId, slotId: h1.slotId, forkId: main, hidden: false })
      yield* writer.SetSlotHidden({ userId, slotId: h1.slotId, forkId: main, hidden: true })
      assert.strictEqual(yield* revision(), before)
      let descendant = child
      for (let i = 0; i < DEEP; i++)
        descendant = (yield* writer.CreateFork({ userId, chatId, fromForkId: descendant, atSlotId: h2.slotId })).fork.id
      const inheritedRevision = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return (yield* historyRevision(sql, userId, chatId, h2.slotId, 10, descendant))[0]!.revision
      }).pipe(Effect.provide(SqliteClient.layer({ filename: databaseFile(dir), readonly: true })))
      assert.strictEqual(inheritedRevision, before)
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("LCM enable shows the imported range only in its fork and forks made afterwards", () => {
    const dir = tempDir("fork-deletion-review")
    return Effect.gen(function* () {
      const { writer, reader, userId, chatId, main, side, root, h1, h2 } = yield* setup(dir)
      yield* fixtureSql(dir, [
        { sql: "DROP TRIGGER slots_hide_frozen" },
        { sql: "UPDATE slots SET context_excluded = 1 WHERE id = ?", params: [root.slotId] }
      ])
      const approved = { jobs: 0, tokens: 0, cost: 0, currency: "USD" }
      const params = {
        userId,
        chatId,
        forkId: main,
        leafSlotId: h2.slotId,
        choice: "scratch" as const,
        approved,
        imported: {
          noteEntity: "synthetic-note",
          content: "Synthetic summary",
          firstSlotId: root.slotId,
          lastSlotId: h1.slotId,
          slotCount: 2,
          hidden: 1
        }
      }
      yield* writer.SetSlotHidden({ userId, slotId: h1.slotId, forkId: main, hidden: true })
      yield* writer.SetSlotHidden({ userId, slotId: h1.slotId, forkId: side, hidden: true })
      const checkpoint = (yield* writer.CreateFork({ userId, chatId, fromForkId: main, atSlotId: h2.slotId })).fork.id
      let stage = yield* writer.StageLcmEnable(params)
      while (!stage.ready) stage = yield* writer.StageLcmEnable({ ...params, runId: stage.runId })
      yield* writer.EnableLcm({ ...params, runId: stage.runId })
      const hidden = (forkId: ForkId) =>
        Effect.map(
          reader.GetPath({ userId, chatId, forkId, leafSlotId: null, limit: 100 }),
          (path) => path.entries.find((e) => e.slotId === h1.slotId)!.contextExcluded
        )
      assert.isFalse(yield* hidden(main))
      assert.isTrue(yield* hidden(side))
      assert.isTrue(yield* hidden(checkpoint))
      const rootHidden = (forkId: ForkId) =>
        Effect.map(
          reader.GetPath({ userId, chatId, forkId, leafSlotId: null, limit: 100 }),
          (path) => path.entries.find((e) => e.slotId === root.slotId)!.contextExcluded
        )
      assert.isFalse(yield* rootHidden(main))
      assert.isTrue(yield* rootHidden(side))
      assert.isTrue(yield* rootHidden(checkpoint))
      const child = (yield* writer.CreateFork({ userId, chatId, fromForkId: main, atSlotId: h2.slotId })).fork.id
      yield* writer.SetSlotHidden({ userId, slotId: h1.slotId, forkId: main, hidden: true })
      assert.isFalse(yield* hidden(child))
      assert.isTrue(yield* hidden(main))
      // A deep chain keeps both the range and the relative precedence of later hides.
      let descendant = child
      for (let i = 0; i < DEEP; i++) {
        yield* writer.SetSlotHidden({ userId, slotId: h2.slotId, forkId: descendant, hidden: i % 2 === 0 })
        descendant = (yield* writer.CreateFork({ userId, chatId, fromForkId: descendant, atSlotId: h2.slotId })).fork.id
      }
      assert.isFalse(yield* hidden(descendant))
      assert.isFalse(yield* rootHidden(descendant))
    }).pipe(Effect.provide(database(dir)))
  })
})

it.live("a new fork after the warning prevents both purge and empty-bin until reviewed", () => {
  const dir = tempDir("fork-deletion-review")
  return Effect.gen(function* () {
    const { writer, reader, userId, chatId, main, side, a1, g1, texts, bin } = yield* setup(dir)
    const item = yield* writer.DeleteMessage({ userId, slotId: a1.slotId, forkId: main })
    const expectedForkIds = (yield* reader.BinItemForks({ userId, itemIds: [item.id] })).map((f) => f.forkId)
    const child = (yield* writer.CreateFork({ userId, chatId, fromForkId: side, atSlotId: g1.slotId })).fork.id
    assert.strictEqual(
      (yield* writer.PurgeBinItem({ userId, itemId: item.id, expectedForkIds }).pipe(Effect.flip))._tag,
      "BinChanged"
    )
    assert.strictEqual(
      (yield* writer.EmptyBin({ userId, itemIds: (yield* bin).map((b) => b.id), expectedForkIds }).pipe(Effect.flip))
        ._tag,
      "BinChanged"
    )
    assert.deepStrictEqual(yield* texts(child), ["root", "h1", "a1", "g1"])
    const reviewed = (yield* reader.BinItemForks({ userId, itemIds: [item.id] })).map((f) => f.forkId)
    yield* writer.PurgeBinItem({ userId, itemId: item.id, expectedForkIds: reviewed })
    assert.deepStrictEqual(yield* texts(child), ["root", "h1", "g1"])
  }).pipe(Effect.provide(database(dir)))
})

it.live("a swipe restored after another fork purged its last alternative restores its message", () => {
  const dir = tempDir("fork-deletion-review")
  return Effect.gen(function* () {
    const { writer, userId, main, side, a1, again, texts } = yield* setup(dir)
    const original = yield* writer.DeleteVersion({ userId, versionId: a1.version.id, forkId: side })
    const alternative = yield* writer.DeleteVersion({ userId, versionId: again, forkId: main })
    yield* writer.PurgeBinItem({ userId, itemId: alternative.id })
    yield* writer.RestoreBinItem({ userId, itemId: original.id })
    assert.deepStrictEqual(yield* texts(side), ["root", "h1", "a1", "g1"])
  }).pipe(Effect.provide(database(dir)))
})

it.live("evicting a swipe cannot empty another fork's deleted message", () => {
  const dir = tempDir("fork-deletion-review")
  return Effect.gen(function* () {
    const { writer, reader, userId, main, side, a1, again, h2 } = yield* setup(dir)
    yield* writer.DeleteVersion({ userId, versionId: again, forkId: main })
    const message = yield* writer.DeleteMessage({ userId, slotId: a1.slotId, forkId: side })
    yield* writer.DeleteMessage({ userId, slotId: h2.slotId, forkId: main })
    yield* writer.RestoreBinItem({ userId, itemId: message.id })
    assert.deepStrictEqual(
      (yield* reader.ListVersions({ userId, slotId: a1.slotId, forkId: side })).map((v) => v.content),
      ["a1", "a1 again"]
    )
  }).pipe(
    Effect.provide(database(dir, { deletedItems: 2, deletedBytes: 1e9, recoveredTexts: 10, recoveredBytes: 1e9 }))
  )
})

it.live("ST unhide addresses the named fork even when another fork has the same tip", () => {
  const dir = tempDir("fork-deletion-review")
  return Effect.gen(function* () {
    const { writer, reader, userId, chatId, main, h1, h2 } = yield* setup(dir)
    yield* writer.SetSlotHidden({ userId, forkId: main, slotId: h1.slotId, hidden: true })
    const child = (yield* writer.CreateFork({ userId, chatId, fromForkId: main, atSlotId: h2.slotId })).fork.id
    yield* writer.StImportUnhide({ userId, chatId, forkId: main, throughSlotId: h2.slotId })
    const hidden = (forkId: ForkId) =>
      Effect.map(
        reader.GetPath({ userId, chatId, forkId, leafSlotId: null, limit: 100 }),
        (path) => path.entries.find((e) => e.slotId === h1.slotId)!.contextExcluded
      )
    assert.isFalse(yield* hidden(main))
    assert.isTrue(yield* hidden(child))
  }).pipe(Effect.provide(database(dir)))
})
