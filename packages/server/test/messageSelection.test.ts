// Several messages deleted as one change, and its Undo (job msgactions1), through the real workers:
// each exactly as DeleteMessage deletes one, branch-local, atomic, restored together.
import { assert, describe, it } from "@effect/vitest"
import { type ForkId, NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import { newCardNote } from "@dreamspan/shared/editing.ts"
import { Effect, Exit } from "effect"
import * as Database from "../src/db/Database.ts"
import { testWorkers } from "./support/bundles.ts"
import { cardDoc } from "./support/docs.ts"
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"
import { tempDir } from "./support/tempDir.ts"

const database = (dataDir = tempDir("multidelete")) =>
  Database.layer({ dataDir, readers: 2, allowNetworkFs: false, ...testWorkers })

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
    const append = (parentSlotId: SlotId | null, content: string, branch = false, forkId?: ForkId) =>
      writer.AppendMessage({
        userId,
        chatId: chat.id,
        ...(forkId === undefined ? {} : { forkId }),
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
    return { writer, reader, userId, chat, cardId: card.entityId, append, path, fork, root, a, b, c, d }
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

  it.live("single Undo past an older deletion restores the original branch", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      yield* s.writer.DeleteMessage({ userId: s.userId, forkId: s.fork, slotId: s.b.slotId })
      yield* s.writer.DeleteMessage({ userId: s.userId, forkId: s.fork, slotId: s.c.slotId })
      const item = yield* s.writer.DeleteMessage({ userId: s.userId, forkId: s.fork, slotId: s.d.slotId })
      yield* s.writer.RestoreBinItem({ userId: s.userId, itemId: item.id })
      assert.deepStrictEqual(yield* s.path(s.fork), ["root", "a", "d"])
      assert.strictEqual((yield* s.reader.ListForks({ userId: s.userId, chatId: s.chat.id })).length, 1)
    }).pipe(Effect.provide(database()))
  )

  it.live("branch-local: another branch that shows them keeps them", () =>
    Effect.gen(function* () {
      const { writer, userId, chat, path, fork, append, a, b, c } = yield* setup()
      const other = yield* append(c.slotId, "other", true)
      assert.notStrictEqual(other.forkId, fork)
      const reader = yield* Database.Reader
      const chatId = chat.id
      const otherState = () => reader.GetPath({ userId, chatId, forkId: other.forkId, leafSlotId: null, limit: 100 })
      const before = yield* otherState()
      const items = yield* writer.DeleteMessages({ userId, forkId: fork, slotIds: [a.slotId, b.slotId] })
      assert.deepStrictEqual(yield* otherState(), before)
      assert.deepStrictEqual(yield* path(fork), ["root", "c", "d"])
      assert.deepStrictEqual(yield* path(other.forkId as ForkId), ["root", "a", "b", "c", "other"])
      // The chat's current branch is the sibling; Undo remains addressed to the original.
      yield* writer.RestoreBinItems({ userId, itemIds: items.map((item) => item.id) })
      assert.deepStrictEqual(yield* path(fork), ["root", "a", "b", "c", "d"])
      assert.deepStrictEqual(yield* otherState(), before)
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

  for (const [label, indices] of [
    ["first", [0]],
    ["tip", [4]],
    ["whole branch", [0, 1, 2, 3, 4]],
    ["non-contiguous reverse input", [4, 2, 0]]
  ] as const)
    it.live(`complete effective state survives delete and Undo: ${label}`, () => {
      const dir = tempDir("delete-state")
      return Effect.gen(function* () {
        const s = yield* setup()
        const path = () =>
          s.reader.GetPath({ userId: s.userId, chatId: s.chat.id, forkId: s.fork, leafSlotId: null, limit: 100 })
        // Stable data includes all stored message/swipe bytes, flags, state and thread/merge records.
        const immutable = () =>
          fixtureSql(
            dir,
            ["versions", "version_texts", "state_events", "thread_splits", "chat_merges", "chat_merge_messages"].map(
              (table) => ({
                sql: `SELECT * FROM ${table} ORDER BY ${table === "chat_merge_messages" ? "merge_id, ordinal" : table === "version_texts" ? "version_seq" : "id"}`
              })
            ),
            { readOnly: true }
          )
        const rows = [s.root, s.a, s.b, s.c, s.d] as const
        const swipe = yield* s.writer.AddVersion({
          userId: s.userId,
          slotId: s.b.slotId,
          select: true,
          version: new NewVersion({
            speakerEntityId: null,
            writer: "model",
            content: "b alternative",
            reasoning: "synthetic private thought",
            direction: "synthetic own-turn direction",
            status: "complete",
            macroMode: "verbatim",
            origin: "generated"
          }),
          commitDraft: null
        })
        yield* s.writer.SetThinkingHidden({
          userId: s.userId,
          forkId: s.fork,
          versionId: swipe.id,
          part: "reasoning",
          hidden: true
        })
        yield* s.writer.SetSlotHidden({ userId: s.userId, forkId: s.fork, slotId: s.a.slotId, hidden: true })
        const before = yield* path()
        const stored = yield* immutable()
        const items = yield* s.writer.DeleteMessages({
          userId: s.userId,
          forkId: s.fork,
          slotIds: indices.map((i) => rows[i].slotId)
        })
        assert.deepStrictEqual(
          items.map((item) => item.targetId),
          [...indices].sort((a, b) => a - b).map((i) => rows[i].slotId)
        )
        yield* s.writer.RestoreBinItems({ userId: s.userId, itemIds: items.map((i) => i.id) })
        const clean = (value: unknown): unknown =>
          JSON.parse(JSON.stringify(value, (key, v) => (key === "rowVersion" ? undefined : v)))
        assert.deepStrictEqual(clean(yield* path()), clean(before))
        assert.deepStrictEqual(yield* immutable(), stored)
        assert.strictEqual((yield* s.reader.ListForks({ userId: s.userId, chatId: s.chat.id })).length, 1)
      }).pipe(Effect.provide(database(dir)))
    })

  for (const mode of ["single", "multi"] as const)
    it.live(`${mode} delete: summaries cannot carry deleted messages into the next request`, () => {
      const dir = tempDir("delete-summary")
      return Effect.gen(function* () {
        const s = yield* setup()
        const leafSummary = yield* completeFixture(
          dir,
          s.writer,
          s.userId,
          s.chat.id,
          [s.root, s.a, s.b, s.c].map((e) => ({
            slotId: e.slotId,
            versionId: e.version.id,
            amendCount: 0
          })),
          [],
          " summary containing b and c"
        )
        const summary = yield* completeFixture(
          dir,
          s.writer,
          s.userId,
          s.chat.id,
          [],
          [leafSummary],
          " condensed summary containing b and c"
        )
        const other = (yield* s.writer.CreateFork({
          userId: s.userId,
          chatId: s.chat.id,
          fromForkId: s.fork,
          atSlotId: s.d.slotId
        })).fork.id
        const read = (forkId = s.fork) => s.reader.GetSummary({ userId: s.userId, forkId, summaryId: summary.id })
        assert.isTrue((yield* read()).fresh)
        const items =
          mode === "multi"
            ? yield* s.writer.DeleteMessages({
                userId: s.userId,
                forkId: s.fork,
                slotIds: [s.b.slotId, s.c.slotId]
              })
            : yield* Effect.forEach([s.b, s.c], (entry) =>
                s.writer.DeleteMessage({
                  userId: s.userId,
                  forkId: s.fork,
                  slotId: entry.slotId
                })
              )
        assert.isTrue((yield* read(other)).fresh)
        assert.isFalse((yield* read()).fresh)
        const next = yield* s.append(s.d.slotId, "", false, s.fork)
        const assembled = yield* s.reader.AssembleContext({
          userId: s.userId,
          chatId: s.chat.id,
          forkId: s.fork,
          slotId: next.slotId,
          versionId: next.version.id,
          now: Date.UTC(2026, 0, 1),
          timeZone: "UTC",
          frozen: null
        })
        const messages = JSON.parse(assembled.snapshot).request.messages as Array<{ content: unknown }>
        assert.isFalse(messages.some((m) => m.content === "b" || m.content === "c"))
        assert.isFalse(JSON.stringify(messages).includes("summary containing b and c"))
        yield* s.writer.RestoreBinItems({ userId: s.userId, itemIds: items.map((i) => i.id) })
        assert.isTrue((yield* read()).fresh)
      }).pipe(Effect.provide(database(dir)))
    })

  it.live("refuses a guessed slot on another branch, atomically", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      const side = yield* s.append(s.b.slotId, "side only", true)
      const before = yield* s.path(s.fork)
      const result = yield* Effect.exit(
        s.writer.DeleteMessages({
          userId: s.userId,
          forkId: s.fork,
          slotIds: [s.a.slotId, side.slotId]
        })
      )
      assert.isTrue(Exit.isFailure(result))
      assert.deepStrictEqual(yield* s.path(s.fork), before)
      assert.strictEqual((yield* s.reader.ListBin({ userId: s.userId, limit: 100, before: null })).length, 0)
    }).pipe(Effect.provide(database()))
  )

  it.live("refuses a guessed slot in another chat of the same owner, atomically", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      const other = yield* setup()
      const result = yield* Effect.exit(
        s.writer.DeleteMessages({ userId: s.userId, forkId: s.fork, slotIds: [s.a.slotId, other.b.slotId] })
      )
      assert.isTrue(Exit.isFailure(result))
      assert.deepStrictEqual(yield* s.path(s.fork), ["root", "a", "b", "c", "d"])
      assert.deepStrictEqual(yield* other.path(other.fork), ["root", "a", "b", "c", "d"])
      assert.strictEqual((yield* s.reader.ListBin({ userId: s.userId, limit: 100, before: null })).length, 0)
    }).pipe(Effect.provide(database()))
  )

  it.live("Undo after a further send restores the deleted tail on one recoverable branch", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      const items = yield* s.writer.DeleteMessages({
        userId: s.userId,
        forkId: s.fork,
        slotIds: [s.c.slotId, s.d.slotId]
      })
      yield* s.append(s.b.slotId, "later")
      yield* s.writer.RestoreBinItems({ userId: s.userId, itemIds: items.map((i) => i.id) })
      const forks = yield* s.reader.ListForks({ userId: s.userId, chatId: s.chat.id })
      assert.strictEqual(forks.length, 2)
      assert.deepStrictEqual(yield* s.path(s.fork), ["root", "a", "b", "later"])
      const restored = forks.find((f) => f.id !== s.fork)!
      assert.deepStrictEqual(yield* s.path(restored.id), ["root", "a", "b", "c", "d"])
    }).pipe(Effect.provide(database()))
  )

  it.live("a reply that starts regenerating refuses the entire stale selection", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      yield* s.writer.AddVersion({
        userId: s.userId,
        slotId: s.b.slotId,
        select: true,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "model",
          content: "",
          status: "generating",
          macroMode: "verbatim",
          origin: "generated"
        }),
        commitDraft: null
      })
      const result = yield* Effect.exit(
        s.writer.DeleteMessages({ userId: s.userId, forkId: s.fork, slotIds: [s.a.slotId, s.b.slotId] })
      )
      assert.isTrue(Exit.isFailure(result))
      assert.strictEqual((yield* s.reader.ListBin({ userId: s.userId, limit: 100, before: null })).length, 0)
      assert.include(yield* s.path(s.fork), "a")
    }).pipe(Effect.provide(database()))
  )

  it.live("group Undo also restores the remainder after one item was restored elsewhere", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      const items = yield* s.writer.DeleteMessages({
        userId: s.userId,
        forkId: s.fork,
        slotIds: [s.b.slotId, s.c.slotId, s.d.slotId]
      })
      yield* s.writer.RestoreBinItem({ userId: s.userId, itemId: items[1]!.id })
      yield* s.writer.RestoreBinItems({ userId: s.userId, itemIds: items.map((item) => item.id) })
      assert.deepStrictEqual(yield* s.path(s.fork), ["root", "a", "b", "c", "d"])
      assert.strictEqual((yield* s.reader.ListForks({ userId: s.userId, chatId: s.chat.id })).length, 1)
    }).pipe(Effect.provide(database()))
  )

  it.live("a child made after Undo keeps the restored messages through a second delete", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      const ids = [s.b.slotId, s.c.slotId]
      const first = yield* s.writer.DeleteMessages({ userId: s.userId, forkId: s.fork, slotIds: ids })
      yield* s.writer.RestoreBinItems({ userId: s.userId, itemIds: first.map((item) => item.id) })
      const other = (yield* s.writer.CreateFork({
        userId: s.userId,
        chatId: s.chat.id,
        fromForkId: s.fork,
        atSlotId: s.d.slotId
      })).fork.id
      const before = yield* s.reader.GetPath({
        userId: s.userId,
        chatId: s.chat.id,
        forkId: other,
        leafSlotId: null,
        limit: 100
      })
      const second = yield* s.writer.DeleteMessages({ userId: s.userId, forkId: s.fork, slotIds: ids })
      assert.deepStrictEqual(
        yield* s.reader.GetPath({ userId: s.userId, chatId: s.chat.id, forkId: other, leafSlotId: null, limit: 100 }),
        before
      )
      yield* s.writer.RestoreBinItems({ userId: s.userId, itemIds: second.map((item) => item.id) })
      assert.deepStrictEqual(yield* s.path(s.fork), ["root", "a", "b", "c", "d"])
    }).pipe(Effect.provide(database()))
  )

  it.live("Undo refuses a mixed-account set before restoring any item", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      const other = yield* setup("another-owner")
      const own = yield* s.writer.DeleteMessages({ userId: s.userId, forkId: s.fork, slotIds: [s.b.slotId] })
      const foreign = yield* other.writer.DeleteMessages({
        userId: other.userId,
        forkId: other.fork,
        slotIds: [other.b.slotId]
      })
      const result = yield* Effect.exit(
        s.writer.RestoreBinItems({ userId: s.userId, itemIds: [own[0]!.id, foreign[0]!.id] })
      )
      assert.isTrue(Exit.isFailure(result))
      assert.deepStrictEqual(yield* s.path(s.fork), ["root", "a", "c", "d"])
      assert.deepStrictEqual(yield* other.path(other.fork), ["root", "a", "c", "d"])
    }).pipe(Effect.provide(database()))
  )

  it.live("separate bin restores keep their existing recovery branches", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      const c = yield* s.writer.DeleteMessage({ userId: s.userId, forkId: s.fork, slotId: s.c.slotId })
      const d = yield* s.writer.DeleteMessage({ userId: s.userId, forkId: s.fork, slotId: s.d.slotId })
      yield* s.append(s.b.slotId, "later")
      yield* s.writer.RestoreBinItem({ userId: s.userId, itemId: c.id })
      yield* s.writer.RestoreBinItem({ userId: s.userId, itemId: d.id })
      assert.strictEqual((yield* s.reader.ListForks({ userId: s.userId, chatId: s.chat.id })).length, 3)
      assert.deepStrictEqual(yield* s.path(s.fork), ["root", "a", "b", "later"])
    }).pipe(Effect.provide(database()))
  )

  it.live("threads, linked copies, split navigation, joins and own-turn notes survive a grouped Undo", () => {
    const dir = tempDir("delete-threads-merge")
    return Effect.gen(function* () {
      const s = yield* setup()
      const wren = yield* s.writer.CreateEntity({
        userId: s.userId,
        kind: "card",
        label: "Wren",
        subtitle: "",
        doc: cardDoc("Wren"),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      yield* s.writer.AddStateEvent({
        userId: s.userId,
        chatId: s.chat.id,
        forkId: s.fork,
        slotId: s.root.slotId,
        versionId: null,
        scope: null,
        data: { key: "participant.join", value: { entity: wren.entityId } }
      })
      const note = yield* s.writer.CreateEntity({
        userId: s.userId,
        kind: "note",
        label: "Inner life",
        subtitle: "",
        doc: {
          ...newCardNote(s.cardId, "Inner life"),
          content: "Synthetic own-turn note.",
          condition: { when: "own_turn" },
          placement: { mode: "section", section: "own_turn" }
        },
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      for (const data of [
        { key: "note.binding", value: { note: note.entityId, revision: note.ref.headRevisionId } },
        { key: "note.activate", value: { note: note.entityId } }
      ] as const)
        yield* s.writer.AddStateEvent({
          userId: s.userId,
          chatId: s.chat.id,
          forkId: s.fork,
          slotId: s.b.slotId,
          versionId: null,
          scope: null,
          data
        })
      const split = yield* s.writer.StartThreads({
        userId: s.userId,
        chatId: s.chat.id,
        forkId: s.fork,
        slotId: s.b.slotId,
        expectedRowVersion: (yield* s.reader.GetSlot({ userId: s.userId, slotId: s.b.slotId, forkId: s.fork })).entry
          .rowVersion,
        threads: [
          { name: null, cast: [s.cardId], writesAs: null },
          { name: null, cast: [wren.entityId], writesAs: null }
        ]
      })
      const peer = split.forkIds[1]!
      yield* s.writer.SetSplitChat({ userId: s.userId, forkId: peer, split: true })
      const sent = yield* s.writer.SendToThreads({
        userId: s.userId,
        chatId: s.chat.id,
        commitDraft: null,
        targets: [
          { forkId: s.fork, parentSlotId: s.d.slotId },
          { forkId: peer, parentSlotId: s.b.slotId }
        ].map((target) => ({
          ...target,
          content: "Linked synthetic message.",
          speakerEntityId: null,
          reply: false,
          replySpeakerEntityId: null
        }))
      })
      const copy = sent.copies[0]!
      const otherCopy = sent.copies[1]!
      if (copy._tag !== "Posted" || otherCopy._tag !== "Posted") return yield* Effect.die("unexpected queued fixture")
      const source = yield* setup()
      const request = {
        userId: s.userId,
        chatId: s.chat.id,
        forkId: s.fork,
        at: copy.slotId,
        source: { chatId: source.chat.id, forkId: source.fork },
        includeLeftOut: true
      }
      const preview = yield* s.reader.PreviewChatMerge(request)
      const joined = yield* s.writer.MergeChat({
        ...request,
        digest: preview.digest,
        title: preview.sourceTitle,
        framing: null
      })
      const leaf = yield* s.append(joined.slotId, "", false, s.fork)
      const path = (forkId: ForkId) =>
        s.reader.GetPath({ userId: s.userId, chatId: s.chat.id, forkId, leafSlotId: null, limit: 100 })
      const state = () =>
        s.reader.StateEventsAt({ userId: s.userId, chatId: s.chat.id, forkId: s.fork, slotId: leaf.slotId })
      const stable = () =>
        fixtureSql(
          dir,
          [
            "SELECT * FROM thread_splits ORDER BY id",
            "SELECT * FROM thread_members ORDER BY split_id, ordinal",
            "SELECT * FROM thread_sends ORDER BY slot_id",
            "SELECT * FROM chat_merges ORDER BY id",
            "SELECT * FROM chat_merge_messages ORDER BY merge_id, ordinal",
            "SELECT * FROM state_events ORDER BY id",
            "SELECT * FROM versions ORDER BY id",
            "SELECT * FROM version_texts ORDER BY version_seq"
          ].map((sql) => ({ sql })),
          { readOnly: true }
        )
      const before = yield* path(s.fork)
      const peerBefore = (yield* path(peer)).entries.map((entry) => entry.version)
      const sourceBefore = yield* source.path(source.fork)
      const events = yield* state()
      assert.include(JSON.stringify(events), note.entityId)
      const records = yield* stable()
      const items = yield* s.writer.DeleteMessages({
        userId: s.userId,
        forkId: s.fork,
        slotIds: [s.b.slotId, s.c.slotId, copy.slotId, joined.slotId]
      })
      assert.deepStrictEqual(
        (yield* path(peer)).entries.map((entry) => entry.version),
        peerBefore
      )
      assert.deepStrictEqual(yield* source.path(source.fork), sourceBefore)
      assert.deepStrictEqual(yield* stable(), records)
      yield* s.writer.RestoreBinItems({ userId: s.userId, itemIds: items.map((item) => item.id) })
      const clean = (value: unknown) =>
        JSON.parse(JSON.stringify(value, (key, v) => (key === "rowVersion" ? undefined : v)))
      assert.deepStrictEqual(clean(yield* path(s.fork)), clean(before))
      assert.deepStrictEqual(yield* state(), events)
      assert.deepStrictEqual(yield* stable(), records)
      // The separate, explicit copies action addresses only the named copy in its thread.
      yield* s.writer.DeleteMessages({ userId: s.userId, forkId: peer, slotIds: [otherCopy.slotId] })
      assert.include(
        (yield* path(s.fork)).entries.map((entry) => entry.slotId),
        copy.slotId
      )
    }).pipe(Effect.provide(database(dir)))
  })

  it.live("leaves the chat as deleting the same messages one at a time does", () =>
    Effect.gen(function* () {
      const one = yield* setup("one")
      const many = yield* setup("many")
      const normalizeFor = new Map<typeof one, (value: unknown) => unknown>()
      for (const s of [one, many]) {
        const alternative = yield* s.writer.AddVersion({
          userId: s.userId,
          slotId: s.b.slotId,
          version: new NewVersion({
            speakerEntityId: s.cardId,
            writer: "model",
            content: "An alternate 🌊 港.",
            reasoning: "A synthetic thought 💭.",
            direction: "An own-turn direction.",
            status: "complete",
            macroMode: "verbatim",
            origin: "generated"
          }),
          select: true,
          commitDraft: null
        })
        yield* s.writer.SetThinkingHidden({
          userId: s.userId,
          forkId: s.fork,
          versionId: alternative.id,
          part: "reasoning",
          hidden: true
        })
        yield* s.writer.SetSlotHidden({ userId: s.userId, forkId: s.fork, slotId: s.root.slotId, hidden: true })
        const side = yield* s.append(s.b.slotId, "side", true)
        const ids = new Map<string, string>([
          [s.userId, "user"],
          [s.chat.id, "chat"],
          [s.fork, "main"],
          [s.cardId, "card"],
          [side.slotId, "side-slot"],
          [side.forkId, "side-fork"],
          [side.version.id, "side-version"],
          [alternative.id, "alternative"]
        ])
        for (const [index, entry] of [s.root, s.a, s.b, s.c, s.d].entries()) {
          ids.set(entry.slotId, `slot-${index}`)
          ids.set(entry.version.id, `version-${index}`)
        }
        normalizeFor.set(s, (value) =>
          JSON.parse(
            JSON.stringify(value, (key, v) =>
              ["createdAt", "updatedAt", "rowVersion", "group", "groupSize"].includes(key)
                ? undefined
                : typeof v === "string"
                  ? (ids.get(v) ?? v)
                  : v
            )
          )
        )
      }
      for (const slot of [one.b, one.d])
        yield* one.writer.DeleteMessage({ userId: one.userId, slotId: slot.slotId, forkId: one.fork })
      yield* many.writer.DeleteMessages({
        userId: many.userId,
        forkId: many.fork,
        slotIds: [many.b.slotId, many.d.slotId]
      })
      const shape = (s: typeof one) =>
        Effect.gen(function* () {
          const forks = yield* s.reader.ListForks({ userId: s.userId, chatId: s.chat.id })
          const paths = yield* Effect.forEach(forks, (fork) =>
            s.reader.GetPath({ userId: s.userId, chatId: s.chat.id, forkId: fork.id, leafSlotId: null, limit: 100 })
          )
          const bin = (yield* s.reader.ListBin({ userId: s.userId, limit: 100, before: null })).map(
            ({ kind, targetId, title, excerpt, origin, byteSize }) => ({
              kind,
              targetId,
              title,
              excerpt,
              origin,
              byteSize
            })
          )
          return normalizeFor.get(s)!({ paths, bin })
        })
      assert.deepStrictEqual(yield* shape(many), yield* shape(one))
    }).pipe(Effect.provide(database()))
  )
})

// Hiding several from the model, or showing them, as one change (job selecthide1): each exactly as
// SetSlotHidden hides one, in that fork only, all or nothing.
describe("hiding several messages from the model", () => {
  const hiddenIn = (s: Effect.Success<ReturnType<typeof setup>>, forkId: ForkId) =>
    s.reader
      .GetPath({ userId: s.userId, chatId: s.chat.id, forkId, leafSlotId: null, limit: 100 })
      .pipe(Effect.map((w) => w.entries.filter((e) => e.contextExcluded).map((e) => e.version.content)))

  it.live("hides and shows in one call, in this branch only; changed names what wasn't so", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      const other = yield* s.append(s.c.slotId, "other", true)
      yield* s.writer.SetSlotHidden({ userId: s.userId, forkId: s.fork, slotId: s.a.slotId, hidden: true })
      const hid = yield* s.writer.SetSlotsHidden({
        userId: s.userId,
        forkId: s.fork,
        slotIds: [s.a.slotId, s.b.slotId, s.c.slotId],
        hidden: true
      })
      assert.strictEqual(hid.chatId, s.chat.id)
      assert.deepStrictEqual(hid.changed, [s.b.slotId, s.c.slotId])
      assert.deepStrictEqual(yield* hiddenIn(s, s.fork), ["a", "b", "c"])
      assert.deepStrictEqual(yield* hiddenIn(s, other.forkId as ForkId), [])
      // The Undo: the same call, the other way, with what changed.
      const undo = yield* s.writer.SetSlotsHidden({
        userId: s.userId,
        forkId: s.fork,
        slotIds: hid.changed,
        hidden: false
      })
      assert.deepStrictEqual(undo.changed, [s.b.slotId, s.c.slotId])
      assert.deepStrictEqual(yield* hiddenIn(s, s.fork), ["a"])
      const path = yield* s.reader.GetPath({
        userId: s.userId,
        chatId: s.chat.id,
        forkId: s.fork,
        leafSlotId: null,
        limit: 100
      })
      assert.isTrue(path.entries.find((e) => e.slotId === s.a.slotId)!.hiddenByUser)
    }).pipe(Effect.provide(database()))
  )

  it.live("all or nothing: a message not shown in the fork, or another's, hides none", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      const side = yield* s.append(s.b.slotId, "side", true)
      yield* s.writer.DeleteMessage({ userId: s.userId, slotId: s.c.slotId, forkId: s.fork })
      for (const slotIds of [
        [s.a.slotId, s.c.slotId],
        [s.a.slotId, side.slotId]
      ]) {
        const exit = yield* Effect.exit(
          s.writer.SetSlotsHidden({ userId: s.userId, forkId: s.fork, slotIds, hidden: true })
        )
        assert.isTrue(Exit.isFailure(exit))
      }
      const other = yield* setup("bo")
      const mixed = yield* Effect.exit(
        s.writer.SetSlotsHidden({
          userId: other.userId,
          forkId: other.fork,
          slotIds: [other.a.slotId, s.a.slotId],
          hidden: true
        })
      )
      assert.isTrue(Exit.isFailure(mixed))
      assert.deepStrictEqual(yield* hiddenIn(s, s.fork), [])
      assert.deepStrictEqual(yield* hiddenIn(other, other.fork), [])
    }).pipe(Effect.provide(database()))
  )

  it.live("summaries, context and stored state are as hiding them one at a time leaves them", () =>
    Effect.gen(function* () {
      const run = (mode: "single" | "multi") => {
        const dir = tempDir(`hide-summary-${mode}`)
        return Effect.gen(function* () {
          const s = yield* setup()
          const leaf = yield* completeFixture(
            dir,
            s.writer,
            s.userId,
            s.chat.id,
            [s.root, s.a, s.b, s.c].map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: 0 })),
            [],
            " summary containing b and c"
          )
          const other = (yield* s.writer.CreateFork({
            userId: s.userId,
            chatId: s.chat.id,
            fromForkId: s.fork,
            atSlotId: s.d.slotId
          })).fork.id
          const read = (forkId: ForkId) => s.reader.GetSummary({ userId: s.userId, forkId, summaryId: leaf.id })
          if (mode === "multi")
            yield* s.writer.SetSlotsHidden({
              userId: s.userId,
              forkId: s.fork,
              slotIds: [s.b.slotId, s.c.slotId],
              hidden: true
            })
          else
            for (const entry of [s.b, s.c])
              yield* s.writer.SetSlotHidden({ userId: s.userId, forkId: s.fork, slotId: entry.slotId, hidden: true })
          const fresh = [(yield* read(s.fork)).fresh, (yield* read(other)).fresh]
          const next = yield* s.append(s.d.slotId, "", false, s.fork)
          const assembled = yield* s.reader.AssembleContext({
            userId: s.userId,
            chatId: s.chat.id,
            forkId: s.fork,
            slotId: next.slotId,
            versionId: next.version.id,
            now: Date.UTC(2026, 0, 1),
            timeZone: "UTC",
            frozen: null
          })
          const messages = (JSON.parse(assembled.snapshot).request.messages as Array<{ content: unknown }>).map(
            // The fixture writes its input ids into the summary text: each run has its own.
            (m) => (typeof m.content === "string" ? m.content.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "id") : m.content)
          )
          const ids = new Map<string, string>()
          for (const [i, e] of [s.root, s.a, s.b, s.c, s.d].entries()) ids.set(e.slotId, `slot-${i}`)
          ids.set(s.fork, "main")
          ids.set(other, "other")
          ids.set(s.chat.id, "chat")
          const [overrides, changes] = yield* fixtureSql(
            dir,
            [
              {
                sql: "SELECT fork_id, kind, target_id, slot_id, flag FROM fork_overrides WHERE kind = 'hide' ORDER BY seq"
              },
              { sql: "SELECT slot_id, fork_id, chat_id, depth FROM history_changes ORDER BY seq" }
            ],
            { readOnly: true }
          )
          const stored = JSON.parse(
            JSON.stringify({ overrides, changes }, (_, v) => (typeof v === "string" ? (ids.get(v) ?? v) : v))
          )
          return { fresh, messages, stored }
        }).pipe(Effect.provide(database(dir)))
      }
      const single = yield* run("single")
      const multi = yield* run("multi")
      assert.deepStrictEqual(multi, single)
      assert.isFalse(JSON.stringify(multi.messages).includes('"b"'))
      assert.isAtLeast(multi.stored.overrides.length, 2)
    })
  )
})
