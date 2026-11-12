import { assert, it } from "@effect/vitest"
import { NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

it.live(
  "every newly created alternative or copy records its writing fork, and split/delete retain that identity",
  () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client(),
        writer = yield* Writer,
        reader = yield* Reader
      const userId = (yield* api.Whoami()).id
      const chat = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "Synthetic provenance",
        participants: [],
        greeting: null
      })
      const main = chat.currentForkId!
      const version = (content: string) =>
        new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content,
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      const first = yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        forkId: main,
        parentSlotId: null,
        branch: false,
        commitDraft: null,
        version: version("First.")
      })
      const { fork: peer } = yield* writer.CreateFork({
        userId,
        chatId: chat.id,
        fromForkId: main,
        atSlotId: first.slotId
      })
      const own = yield* writer.AddVersion({
        userId,
        slotId: first.slotId,
        forkId: peer.id,
        version: version("Peer handwritten swipe."),
        select: false,
        commitDraft: null
      })
      const edit = yield* writer.AddVersion({
        userId,
        slotId: first.slotId,
        forkId: peer.id,
        version: new NewVersion({ ...version("Peer edit."), origin: "edited", sourceVersionId: first.version.id }),
        select: false,
        commitDraft: null
      })
      const anchor = yield* reader.GetSlot({ userId, slotId: first.slotId, forkId: peer.id })
      const copy = yield* writer.AmendVersion({
        userId,
        forkId: peer.id,
        versionId: first.version.id,
        expectedRowVersion: anchor.entry.version.rowVersion,
        content: "Peer copy."
      })
      const next = yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        forkId: peer.id,
        parentSlotId: first.slotId,
        branch: false,
        commitDraft: null,
        version: version("Peer message.")
      })
      const amended = yield* writer.AmendVersion({
        userId,
        forkId: peer.id,
        versionId: next.version.id,
        expectedRowVersion: next.version.rowVersion,
        content: "Peer message amended in place."
      })
      assert.strictEqual(amended.id, next.version.id)
      const current = yield* reader.GetSlot({ userId, slotId: first.slotId, forkId: peer.id })
      const inserted = yield* writer.InsertMessage({
        userId,
        chatId: chat.id,
        forkId: peer.id,
        anchorSlotId: first.slotId,
        expectedRowVersion: current.entry.rowVersion,
        body: { _tag: "Write", speaker: null, content: "Inserted in peer." }
      })
      const again = yield* reader.GetSlot({ userId, slotId: first.slotId, forkId: peer.id })
      const duplicate = yield* writer.InsertMessage({
        userId,
        chatId: chat.id,
        forkId: peer.id,
        anchorSlotId: first.slotId,
        expectedRowVersion: again.entry.rowVersion,
        body: { _tag: "Duplicate", versionId: copy.id }
      })
      const rows = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT id,slot_id,authoring_fork_id,fork_id,source_version_id FROM versions WHERE slot_id IN (SELECT id FROM slots WHERE chat_id=?)",
            params: [chat.id]
          }
        ],
        { readOnly: true }
      )
      const stored = (id: string) => rows[0]!.find((r) => r.id === id)!
      assert.strictEqual(stored(first.version.id).authoring_fork_id, main)
      for (const id of [own.id, edit.id, copy.id, next.version.id])
        assert.strictEqual(stored(id).authoring_fork_id, peer.id)
      assert.isNull(stored(own.id).fork_id, "handwritten swipe provenance is not replacement ownership")
      assert.strictEqual(stored(copy.id).fork_id, peer.id)
      assert.strictEqual(stored(copy.id).source_version_id, first.version.id)
      for (const row of rows[0]!.filter((r) => [inserted.slotId, duplicate.slotId].includes(r.slot_id as SlotId)))
        assert.strictEqual(row.authoring_fork_id, peer.id)

      const source = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "Source",
        participants: [],
        greeting: null
      })
      yield* writer.AppendMessage({
        userId,
        chatId: source.id,
        forkId: source.currentForkId!,
        parentSlotId: null,
        branch: false,
        commitDraft: null,
        version: version("Source line.")
      })
      const request = {
        userId,
        chatId: chat.id,
        forkId: main,
        at: null,
        source: { chatId: source.id, forkId: source.currentForkId! },
        includeLeftOut: true
      }
      const preview = yield* reader.PreviewChatMerge(request)
      const merged = yield* writer.MergeChat({
        ...request,
        title: preview.sourceTitle,
        framing: null,
        digest: preview.digest
      })
      const [join] = yield* fixtureSql(
        config.dataDir,
        [{ sql: "SELECT authoring_fork_id FROM versions WHERE slot_id=?", params: [merged.slotId] }],
        { readOnly: true }
      )
      assert.strictEqual(join![0]!.authoring_fork_id, main, "the merge join is created in the destination fork")

      const sourceBin = yield* writer.DeleteChat({ userId, chatId: source.id })
      yield* writer.PurgeBinItem({ userId, itemId: sourceBin.id })
      const [afterSourcePurge] = yield* fixtureSql(
        config.dataDir,
        [{ sql: "SELECT authoring_fork_id FROM versions WHERE slot_id=?", params: [merged.slotId] }],
        { readOnly: true }
      )
      assert.strictEqual(
        afterSourcePurge![0]!.authoring_fork_id,
        main,
        "purging the merge source cannot erase the destination join"
      )

      const { fork: child } = yield* writer.CreateFork({
        userId,
        chatId: chat.id,
        fromForkId: peer.id,
        atSlotId: next.slotId
      })
      yield* api.SetSplitChat({ forkId: peer.id, split: true })
      const split = yield* api.GetSplitChats({ chatId: chat.id, forkId: child.id })
      assert.strictEqual(split.group.forkId, child.id)
      assert.strictEqual(split.group.chatId, chat.id, "split is navigation grouping, not moving physical rows")
      const [afterSplit] = yield* fixtureSql(
        config.dataDir,
        [{ sql: "SELECT authoring_fork_id FROM versions WHERE id=?", params: [next.version.id] }],
        { readOnly: true }
      )
      assert.strictEqual(afterSplit![0]!.authoring_fork_id, peer.id)
      yield* api.SetSplitChat({ forkId: peer.id, split: false })
      const item = yield* writer.DeleteFork({ userId, forkId: peer.id })
      yield* writer.PurgeBinItem({ userId, itemId: item.id })
      const [retained, violations] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT v.authoring_fork_id, v.purged_at AS version_purged, f.purged_at AS fork_purged FROM versions v JOIN forks f ON f.id=v.authoring_fork_id WHERE v.id=?",
            params: [next.version.id]
          },
          { sql: "PRAGMA foreign_key_check" }
        ],
        { readOnly: true }
      )
      assert.strictEqual(retained![0]!.authoring_fork_id, peer.id)
      assert.isNull(retained![0]!.version_purged, "the child retains the shared message")
      assert.isNumber(retained![0]!.fork_purged, "fork purge retains its provenance tombstone")
      assert.deepStrictEqual(violations, [])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  }
)
