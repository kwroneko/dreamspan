import { cardDoc } from "./support/docs.ts"
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { NewVersion, type ForkId, type SlotId } from "@rp/shared/chat.ts"
import type { HistoryCursor, HistoryHit, HistorySearch } from "@rp/shared/historyApi.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { scanHistory } from "../src/db/historyScan.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { slowIt } from "./support/slow.ts"

const search: HistorySearch = {
  pairs: [{ find: "Aria", replace: "Ari" }],
  matchCase: false,
  wholeWord: true,
  regex: false,
  preserveCase: true,
  messages: true,
  swipes: true,
  summaries: true
}
const said = (content: string) =>
  new NewVersion({
    speakerEntityId: null,
    writer: "human",
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: "user_written"
  })
const config = testConfig()
const setup = Effect.gen(function* () {
  const api = yield* client()
  const userId = (yield* api.Whoami()).id
  const writer = yield* Writer
  const reader = yield* Reader
  const chat = yield* writer.CreateChat({
    userId,
    kind: "rp",
    status: "active",
    title: "History",
    participants: [],
    greeting: null
  })
  const chatId = chat.id
  const main = chat.currentForkId!
  const first = yield* writer.AppendMessage({
    userId,
    chatId,
    forkId: main,
    parentSlotId: null,
    branch: false,
    version: said("Aria meets ARIA and aria."),
    commitDraft: null
  })
  yield* writer.AddVersion({
    userId,
    slotId: first.slotId,
    version: said("Aria alternative"),
    select: false,
    commitDraft: null
  })
  const sibling = (yield* writer.CreateFork({ userId, chatId, fromForkId: main, atSlotId: first.slotId })).fork.id
  const text = (forkId: ForkId) =>
    Effect.map(reader.GetPath({ userId, chatId, forkId, leafSlotId: null, limit: 100 }), (p) =>
      p.entries.map((e) => e.version.content)
    )
  return { api, userId, writer, reader, chatId, main, first, sibling, text }
})
describe("history edits", () => {
  it.effect("edits every swipe only here, inherits at earlier points, and undoes only here", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const preview = yield* f.api.PreviewHistory({ chatId: f.chatId, forkId: f.main, search })
      assert.lengthOf(preview.hits, 2)
      assert.strictEqual(preview.hits[0]!.after, "Ari meets ARI and ari.")
      const applied = yield* f.api.ApplyHistoryEdits({
        title: "Rename",
        applications: [
          {
            chatId: f.chatId,
            forkId: f.main,
            edits: preview.hits.map(({ kind, targetId, beforeId, before, after }) => ({
              kind,
              targetId,
              beforeId,
              before,
              after
            }))
          }
        ]
      })
      assert.deepStrictEqual(yield* f.text(f.main), ["Ari meets ARI and ari."])
      assert.deepStrictEqual(yield* f.text(f.sibling), ["Aria meets ARIA and aria."])
      const later = (yield* f.writer.CreateFork({
        userId: f.userId,
        chatId: f.chatId,
        fromForkId: f.main,
        atSlotId: f.first.slotId
      })).fork.id
      assert.deepStrictEqual(yield* f.text(later), ["Ari meets ARI and ari."])
      const inherited = yield* f.api.ListHistoryEdits({ chatId: f.chatId, forkId: later })
      assert.isTrue(inherited[0]!.inherited)
      assert.strictEqual(inherited[0]!.status, "applied")
      const siblingEntry = (yield* f.reader.GetSlot({ userId: f.userId, slotId: f.first.slotId, forkId: f.sibling }))
        .entry
      yield* f.writer.AmendVersion({
        userId: f.userId,
        forkId: f.sibling,
        versionId: siblingEntry.version.id,
        expectedRowVersion: siblingEntry.version.rowVersion,
        content: "Aria on a different path"
      })
      const undo = yield* f.api.UndoHistoryEdit({
        chatId: f.chatId,
        forkId: f.main,
        changesetId: applied.changesetIds[0]!,
        slotId: f.first.slotId
      })
      assert.strictEqual(undo.undone, 2)
      assert.deepStrictEqual(yield* f.text(f.main), ["Aria meets ARIA and aria."])
      assert.deepStrictEqual(yield* f.text(later), ["Ari meets ARI and ari."])
      yield* f.api.UndoHistoryEdit({ chatId: f.chatId, forkId: later, changesetId: applied.changesetIds[0]! })
      assert.deepStrictEqual(yield* f.text(later), ["Aria meets ARIA and aria."])
    }).pipe(Effect.provide(serverLayer(config)))
  )
  it.effect("forks at the tip and earlier messages inherit edits and keep their own undo", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const second = yield* f.writer.AppendMessage({
        userId: f.userId,
        chatId: f.chatId,
        forkId: f.main,
        parentSlotId: f.first.slotId,
        branch: false,
        version: said("Aria at the tower."),
        commitDraft: null
      })
      const preview = yield* f.api.PreviewHistory({ chatId: f.chatId, forkId: f.main, search })
      const applied = yield* f.api.ApplyHistoryEdits({
        title: "Both messages",
        applications: [
          {
            chatId: f.chatId,
            forkId: f.main,
            edits: preview.hits.map(({ kind, targetId, beforeId, before, after }) => ({
              kind,
              targetId,
              beforeId,
              before,
              after
            }))
          }
        ]
      })
      for (const atSlotId of [second.slotId, f.first.slotId]) {
        const fork = (yield* f.writer.CreateFork({ userId: f.userId, chatId: f.chatId, fromForkId: f.main, atSlotId }))
          .fork.id
        const texts = yield* f.text(fork)
        assert.strictEqual(texts.length, atSlotId === second.slotId ? 2 : 1)
        assert.isTrue(texts.every((t) => t.includes("Ari") && !t.includes("Aria")))
        yield* f.api.UndoHistoryEdit({ chatId: f.chatId, forkId: fork, changesetId: applied.changesetIds[0]! })
        assert.isTrue((yield* f.text(fork)).every((t) => t.includes("Aria")))
      }
      assert.deepStrictEqual(yield* f.text(f.main), ["Ari meets ARI and ari.", "Ari at the tower."])
    }).pipe(Effect.provide(serverLayer(config)))
  )
  it.effect("shares a renamed copy across forks and refuses a stale batch atomically", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const preview = yield* f.api.PreviewHistory({ chatId: f.chatId, forkId: f.main, search })
      const result = yield* f.api.ApplyHistoryEdits({
        title: "All chats",
        applications: [f.main, f.sibling].map((forkId) => ({
          chatId: f.chatId,
          forkId,
          edits: preview.hits.map(({ kind, targetId, beforeId, before, after }) => ({
            kind,
            targetId,
            beforeId,
            before,
            after
          }))
        }))
      })
      const a = yield* f.reader.ListVersions({ userId: f.userId, slotId: f.first.slotId, forkId: f.main })
      const b = yield* f.reader.ListVersions({ userId: f.userId, slotId: f.first.slotId, forkId: f.sibling })
      assert.deepStrictEqual(
        a.map((v) => v.id),
        b.map((v) => v.id)
      )
      assert.lengthOf(result.changesetIds, 2)
      assert.strictEqual(
        yield* outcome(
          f.api.ApplyHistoryEdits({
            title: "Stale",
            applications: [
              {
                chatId: f.chatId,
                forkId: f.main,
                edits: preview.hits.map(({ kind, targetId, beforeId, before, after }) => ({
                  kind,
                  targetId,
                  beforeId,
                  before,
                  after
                }))
              }
            ]
          }),
          () => "allowed"
        ),
        "HistoryRejected"
      )
      assert.lengthOf(yield* f.api.ListHistoryEdits({ chatId: f.chatId, forkId: f.main }), 1)
    }).pipe(Effect.provide(serverLayer(config)))
  )
  it.effect("undo keeps a subsequent amend and reports its conflict", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const preview = yield* f.api.PreviewHistory({ chatId: f.chatId, forkId: f.main, search })
      const result = yield* f.api.ApplyHistoryEdits({
        title: "Rename",
        applications: [
          {
            chatId: f.chatId,
            forkId: f.main,
            edits: preview.hits.map(({ kind, targetId, beforeId, before, after }) => ({
              kind,
              targetId,
              beforeId,
              before,
              after
            }))
          }
        ]
      })
      const entry = (yield* f.reader.GetSlot({ userId: f.userId, slotId: f.first.slotId, forkId: f.main })).entry
      yield* f.writer.AmendVersion({
        userId: f.userId,
        forkId: f.main,
        versionId: entry.version.id,
        expectedRowVersion: entry.version.rowVersion,
        content: "A later edit"
      })
      const undo = yield* f.api.UndoHistoryEdit({
        chatId: f.chatId,
        forkId: f.main,
        changesetId: result.changesetIds[0]!
      })
      assert.lengthOf(undo.conflicts, 1)
      assert.deepStrictEqual(yield* f.text(f.main), ["A later edit"])
    }).pipe(Effect.provide(serverLayer(config)))
  )
  it.effect("edits summaries in this fork, keeps renames fresh, and undoes covering summaries together", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const summary = yield* completeFixture(
        config.dataDir,
        f.writer,
        f.userId,
        f.chatId,
        [{ slotId: f.first.slotId, versionId: f.first.version.id, amendCount: 0 }],
        [],
        " Aria"
      )
      const preview = yield* f.api.PreviewHistory({ chatId: f.chatId, forkId: f.main, search })
      assert.lengthOf(
        preview.hits.filter((h) => h.kind === "summary_revision"),
        1
      )
      const edits = preview.hits.map(({ kind, targetId, beforeId, before, after }) => ({
        kind,
        targetId,
        beforeId,
        before,
        after
      }))
      const applied = yield* f.api.ApplyHistoryEdits({
        title: "Rename with summaries",
        applications: [{ chatId: f.chatId, forkId: f.main, summariesIncluded: true, edits }]
      })
      const state = yield* f.api.GetLcmState({ chatId: f.chatId, forkId: f.main, leafSlotId: f.first.slotId })
      assert.isTrue(state.layer[0]!.fresh)
      assert.include(state.layer[0]!.content!, "Ari")
      const old = yield* f.api.GetLcmState({ chatId: f.chatId, forkId: f.sibling, leafSlotId: f.first.slotId })
      assert.include(old.layer[0]!.content!, "Aria")
      yield* f.api.UndoHistoryEdit({
        chatId: f.chatId,
        forkId: f.main,
        changesetId: applied.changesetIds[0]!,
        slotId: f.first.slotId
      })
      const restored = yield* f.api.GetLcmState({ chatId: f.chatId, forkId: f.main, leafSlotId: f.first.slotId })
      assert.strictEqual(restored.layer[0]!.revisionId, summary.revisionId)
      assert.isTrue(restored.layer[0]!.fresh)
      const again = yield* f.api.PreviewHistory({ chatId: f.chatId, forkId: f.main, search })
      yield* f.api.ApplyHistoryEdits({
        title: "Again",
        applications: [
          {
            chatId: f.chatId,
            forkId: f.main,
            summariesIncluded: true,
            edits: again.hits.map(({ kind, targetId, beforeId, before, after }) => ({
              kind,
              targetId,
              beforeId,
              before,
              after
            }))
          }
        ]
      })
      const messageOnly = yield* f.api.PreviewHistory({
        chatId: f.chatId,
        forkId: f.main,
        search: { ...search, summaries: false, pairs: [{ find: "Ari", replace: "Ada" }] }
      })
      const newer = yield* f.api.ApplyHistoryEdits({
        title: "Messages only",
        applications: [
          {
            chatId: f.chatId,
            forkId: f.main,
            edits: messageOnly.hits.map(({ kind, targetId, beforeId, before, after }) => ({
              kind,
              targetId,
              beforeId,
              before,
              after
            }))
          }
        ]
      })
      yield* f.api.UndoHistoryEdit({ chatId: f.chatId, forkId: f.main, changesetId: newer.changesetIds[0]! })
      const backToFresh = yield* f.api.GetLcmState({ chatId: f.chatId, forkId: f.main, leafSlotId: f.first.slotId })
      assert.isTrue(backToFresh.layer[0]!.fresh)
      const entry = (yield* f.reader.GetSlot({ userId: f.userId, slotId: f.first.slotId, forkId: f.main })).entry
      yield* f.writer.AmendVersion({
        userId: f.userId,
        forkId: f.main,
        versionId: entry.version.id,
        expectedRowVersion: entry.version.rowVersion,
        content: "A new scene entirely"
      })
      const stale = yield* f.api.GetLcmState({ chatId: f.chatId, forkId: f.main, leafSlotId: f.first.slotId })
      assert.isFalse(stale.layer[0]!.fresh)
    }).pipe(Effect.provide(serverLayer(config)))
  )
  slowIt.effect("scans beyond a window and FTS does not lose Unicode boundary matches", () =>
    Effect.gen(function* () {
      const f = yield* setup
      for (let i = 0; i < 105; i++)
        yield* f.writer.AddVersion({
          userId: f.userId,
          slotId: f.first.slotId,
          version: said(i === 104 ? "Aria🙂" : "Aria extra " + i),
          select: false,
          commitDraft: null
        })
      const first = yield* f.api.PreviewHistory({ chatId: f.chatId, forkId: f.main, search })
      assert.lengthOf(first.hits, 100)
      assert.isNotNull(first.next)
      const last = yield* f.api.PreviewHistory({ chatId: f.chatId, forkId: f.main, search, cursor: first.next! })
      assert.isTrue(last.hits.some((h) => h.before === "Aria🙂"))
      assert.isNull(last.next)
    }).pipe(Effect.provide(serverLayer(config)))
  )
  it.effect("groups stay frozen for a fork made while the panel is open", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const preview = yield* f.api.PreviewHistory({ chatId: f.chatId, forkId: f.main, search })
      const edits = preview.hits.map(({ kind, targetId, beforeId, before, after }) => ({
        kind,
        targetId,
        beforeId,
        before,
        after
      }))
      const applied = yield* f.api.ApplyHistoryEdits({
        title: "Rename",
        applications: [{ chatId: f.chatId, forkId: f.main, edits }]
      })
      const child = (yield* f.writer.CreateFork({
        userId: f.userId,
        chatId: f.chatId,
        fromForkId: f.main,
        atSlotId: f.first.slotId
      })).fork.id
      const again = yield* f.api.PreviewHistory({
        chatId: f.chatId,
        forkId: f.main,
        search: { ...search, pairs: [{ find: "Ari", replace: "Ada" }] }
      })
      yield* f.api.ApplyHistoryEdits({
        title: "Rename",
        groupId: applied.groupId,
        applications: [
          {
            chatId: f.chatId,
            forkId: f.main,
            edits: again.hits.map(({ kind, targetId, beforeId, before, after }) => ({
              kind,
              targetId,
              beforeId,
              before,
              after
            }))
          }
        ]
      })
      assert.deepStrictEqual(yield* f.text(child), ["Ari meets ARI and ari."])
      const history = yield* f.api.ListHistoryEdits({ chatId: f.chatId, forkId: child })
      assert.lengthOf(history, 1)
      assert.isTrue(history[0]!.items.every((i) => i.applied))
    }).pipe(Effect.provide(serverLayer(config)))
  )
  it.effect("counts cast forks and applies or declines a rename in the requested scope", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const card = yield* f.writer.CreateEntity({
        userId: f.userId,
        kind: "card",
        label: "Aria",
        subtitle: "",
        doc: cardDoc("Aria"),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      yield* f.writer.AddStateEvent({
        userId: f.userId,
        chatId: f.chatId,
        forkId: f.main,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "participant.join", value: { entity: card.ref.entityId } }
      })
      const child = (yield* f.writer.CreateFork({
        userId: f.userId,
        chatId: f.chatId,
        fromForkId: f.main,
        atSlotId: f.first.slotId
      })).fork.id
      const other = yield* f.writer.CreateChat({
        userId: f.userId,
        kind: "rp",
        status: "active",
        title: "Other story",
        participants: [],
        greeting: null
      })
      yield* f.writer.AddStateEvent({
        userId: f.userId,
        chatId: other.id,
        forkId: other.currentForkId!,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "participant.join", value: { entity: card.ref.entityId } }
      })
      yield* f.writer.AppendMessage({
        userId: f.userId,
        chatId: other.id,
        forkId: other.currentForkId!,
        parentSlotId: null,
        branch: false,
        version: said("Aria in another story"),
        commitDraft: null
      })
      const targets = yield* f.api.RenameHistoryTargets({ entityId: card.ref.entityId })
      assert.lengthOf(targets, 3)
      const params = { entityId: card.ref.entityId, oldName: "Aria", newName: "Ari", chatId: f.chatId, forkId: f.main }
      assert.strictEqual(yield* f.api.RenameHistory({ ...params, scope: "none" }), 0)
      assert.lengthOf(yield* f.api.ListHistoryEdits({ chatId: f.chatId, forkId: f.main }), 0)
      assert.strictEqual(yield* f.api.RenameHistory({ ...params, scope: "all" }), 3)
      assert.include((yield* f.text(f.main))[0]!, "Ari")
      assert.include((yield* f.text(child))[0]!, "Ari")
      assert.include((yield* f.text(f.sibling))[0]!, "Aria")
      const swapped = yield* f.api.ForkCard({
        refId: card.ref.id,
        name: "Other cast",
        nickname: "Other",
        characterVersion: "fork"
      })
      yield* f.api.ChangeCast({
        chatId: f.chatId,
        forkId: child,
        slotId: f.first.slotId,
        change: { _tag: "Swap", entityId: swapped.entityId, replaces: card.ref.entityId }
      })
      assert.lengthOf(yield* f.api.RenameHistoryTargets({ entityId: card.ref.entityId }), 2)
      assert.deepStrictEqual(yield* f.api.RenameHistoryTargets({ entityId: swapped.entityId }), [
        { chatId: f.chatId, forkId: child }
      ])
      yield* f.api.DeleteFork({ forkId: child })
      assert.lengthOf(yield* f.api.RenameHistoryTargets({ entityId: swapped.entityId }), 0)
    }).pipe(Effect.provide(serverLayer(config)))
  )
  it.effect("adds and replaces state through fork-local suppression and undoes it locally", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const first = JSON.stringify({
        scope: null,
        data: { key: "macro.binding", value: { name: "place", value: "garden" } }
      })
      const added = yield* f.api.ApplyHistoryEdits({
        title: "State",
        applications: [
          {
            chatId: f.chatId,
            forkId: f.main,
            edits: [
              { kind: "state_event", targetId: "", beforeId: "", before: "", after: first },
              {
                kind: "state_event",
                targetId: "",
                beforeId: "",
                before: "",
                after: JSON.stringify({
                  scope: null,
                  data: { key: "var.set", value: { name: "weather", value: "rain" } }
                })
              }
            ]
          }
        ]
      })
      const history = yield* f.api.ListHistoryEdits({ chatId: f.chatId, forkId: f.main })
      const item = history[0]!.items[0]!
      assert.isTrue(item.applied)
      assert.lengthOf(history[0]!.items, 2)
      const read = (forkId: ForkId) =>
        f.reader.StateEventsAt({ userId: f.userId, chatId: f.chatId, forkId, slotId: f.first.slotId })
      assert.strictEqual((yield* read(f.main)).filter((e) => e.data.key === "macro.binding").length, 1)
      assert.strictEqual((yield* read(f.sibling)).filter((e) => e.data.key === "macro.binding").length, 0)
      const replaced = yield* f.api.ApplyHistoryEdits({
        title: "New place",
        applications: [
          {
            chatId: f.chatId,
            forkId: f.main,
            edits: [
              {
                kind: "state_event",
                targetId: item.targetId,
                beforeId: item.targetId,
                before: first,
                after: JSON.stringify({
                  scope: null,
                  data: { key: "macro.binding", value: { name: "place", value: "tower" } }
                })
              }
            ]
          }
        ]
      })
      const state = yield* read(f.main)
      assert.strictEqual(state.filter((e) => e.data.key === "macro.binding").length, 1)
      yield* f.api.UndoHistoryEdit({ chatId: f.chatId, forkId: f.main, changesetId: replaced.changesetIds[0]! })
      yield* f.api.UndoHistoryEdit({ chatId: f.chatId, forkId: f.main, changesetId: added.changesetIds[0]! })
      assert.strictEqual((yield* read(f.main)).filter((e) => e.data.key === "macro.binding").length, 0)
    }).pipe(Effect.provide(serverLayer(config)))
  )
  it.effect("renames stay fresh when the summarized input was already a fork copy", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const edits = (yield* f.api.PreviewHistory({ chatId: f.chatId, forkId: f.main, search })).hits.map(
        ({ kind, targetId, beforeId, before, after }) => ({ kind, targetId, beforeId, before, after })
      )
      yield* f.api.ApplyHistoryEdits({
        title: "First rename",
        applications: [{ chatId: f.chatId, forkId: f.main, edits }]
      })
      const input = (yield* f.reader.GetSlot({ userId: f.userId, slotId: f.first.slotId, forkId: f.main })).entry
        .version
      yield* completeFixture(
        config.dataDir,
        f.writer,
        f.userId,
        f.chatId,
        [{ slotId: f.first.slotId, versionId: input.id, amendCount: 0 }],
        [],
        " Ari"
      )
      const again = (yield* f.api.PreviewHistory({
        chatId: f.chatId,
        forkId: f.main,
        search: { ...search, pairs: [{ find: "Ari", replace: "Ada" }] }
      })).hits.map(({ kind, targetId, beforeId, before, after }) => ({ kind, targetId, beforeId, before, after }))
      yield* f.api.ApplyHistoryEdits({
        title: "Second rename",
        applications: [{ chatId: f.chatId, forkId: f.main, summariesIncluded: true, edits: again }]
      })
      const state = yield* f.api.GetLcmState({ chatId: f.chatId, forkId: f.main, leafSlotId: f.first.slotId })
      assert.isTrue(state.layer[0]!.fresh)
    }).pipe(Effect.provide(serverLayer(config)))
  )
  it.effect("a later unrelated summary changeset makes its previously renamed parent stale", () =>
    Effect.gen(function* () {
      for (const reuseGroup of [false, true]) {
        const f = yield* setup
        const child = yield* completeFixture(
          config.dataDir,
          f.writer,
          f.userId,
          f.chatId,
          [{ slotId: f.first.slotId, versionId: f.first.version.id, amendCount: 0 }],
          [],
          " Aria"
        )
        yield* completeFixture(config.dataDir, f.writer, f.userId, f.chatId, [], [child], " Aria")
        const edits = (yield* f.api.PreviewHistory({ chatId: f.chatId, forkId: f.main, search })).hits.map(
          ({ kind, targetId, beforeId, before, after }) => ({ kind, targetId, beforeId, before, after })
        )
        const applied = yield* f.api.ApplyHistoryEdits({
          title: "Rename all",
          applications: [{ chatId: f.chatId, forkId: f.main, summariesIncluded: true, edits }]
        })
        const first = yield* f.api.GetLcmState({ chatId: f.chatId, forkId: f.main, leafSlotId: f.first.slotId })
        assert.strictEqual(first.layer[0]!.level, 2)
        assert.isTrue(first.layer[0]!.fresh)
        const matches = yield* f.api.PreviewHistory({
          chatId: f.chatId,
          forkId: f.main,
          search: { ...search, pairs: [{ find: "Ari", replace: "Ada" }] }
        })
        const hit = matches.hits.find((h) => h.targetId === child.id)!
        const { kind, targetId, beforeId, before, after } = hit
        yield* f.api.ApplyHistoryEdits({
          title: "Only child summary",
          ...(reuseGroup ? { groupId: applied.groupId } : {}),
          applications: [{ chatId: f.chatId, forkId: f.main, edits: [{ kind, targetId, beforeId, before, after }] }]
        })
        const stale = yield* f.api.GetLcmState({ chatId: f.chatId, forkId: f.main, leafSlotId: f.first.slotId })
        assert.isFalse(stale.layer.find((s) => s.level === 2)?.fresh ?? false, `reuse group: ${reuseGroup}`)
      }
    }).pipe(Effect.provide(serverLayer(config)))
  )
  it.effect("a rename cannot repair summaries made stale by an earlier amend or message-only edit", () =>
    Effect.gen(function* () {
      for (const mode of ["amend", "other group", "same group"] as const) {
        const f = yield* setup
        yield* completeFixture(
          config.dataDir,
          f.writer,
          f.userId,
          f.chatId,
          [{ slotId: f.first.slotId, versionId: f.first.version.id, amendCount: 0 }],
          [],
          " Aria"
        )
        let groupId: string | undefined
        if (mode === "amend") {
          yield* f.writer.AmendVersion({
            userId: f.userId,
            forkId: f.main,
            versionId: f.first.version.id,
            expectedRowVersion: 1,
            content: "Aria has a different story."
          })
        } else {
          const preview = yield* f.api.PreviewHistory({
            chatId: f.chatId,
            forkId: f.main,
            search: { ...search, summaries: false }
          })
          const result = yield* f.api.ApplyHistoryEdits({
            title: "Messages only",
            applications: [
              {
                chatId: f.chatId,
                forkId: f.main,
                edits: preview.hits.map(({ kind, targetId, beforeId, before, after }) => ({
                  kind,
                  targetId,
                  beforeId,
                  before,
                  after
                }))
              }
            ]
          })
          if (mode === "same group") groupId = result.groupId
        }
        const preview = yield* f.api.PreviewHistory({
          chatId: f.chatId,
          forkId: f.main,
          search: { ...search, pairs: [{ find: mode === "amend" ? "Aria" : "Ari", replace: "Ada" }] }
        })
        yield* f.api.ApplyHistoryEdits({
          title: "With summaries",
          ...(groupId ? { groupId } : {}),
          applications: [
            {
              chatId: f.chatId,
              forkId: f.main,
              summariesIncluded: true,
              edits: preview.hits.map(({ kind, targetId, beforeId, before, after }) => ({
                kind,
                targetId,
                beforeId,
                before,
                after
              }))
            }
          ]
        })
        const state = yield* f.api.GetLcmState({ chatId: f.chatId, forkId: f.main, leafSlotId: f.first.slotId })
        assert.isFalse(state.layer[0]!.fresh, mode)
      }
    }).pipe(Effect.provide(serverLayer(config)))
  )
  it.effect("a fork-local deletion after preview refuses the entire batch", () =>
    Effect.gen(function* () {
      for (const kind of ["message", "swipe"] as const) {
        const f = yield* setup
        const preview = yield* f.api.PreviewHistory({ chatId: f.chatId, forkId: f.main, search })
        if (kind === "message") yield* f.api.DeleteMessage({ slotId: f.first.slotId, forkId: f.main })
        else {
          const versions = yield* f.reader.ListVersions({ userId: f.userId, slotId: f.first.slotId, forkId: f.main })
          yield* f.api.DeleteVersion({
            versionId: versions.find((v) => v.id !== f.first.version.id)!.id,
            forkId: f.main
          })
        }
        const result = yield* outcome(
          f.api.ApplyHistoryEdits({
            title: "Stale deletion",
            applications: [
              {
                chatId: f.chatId,
                forkId: f.main,
                edits: preview.hits.map(({ kind, targetId, beforeId, before, after }) => ({
                  kind,
                  targetId,
                  beforeId,
                  before,
                  after
                }))
              }
            ]
          }),
          () => "allowed"
        )
        assert.include(["NotFound", "HistoryRejected"], result, kind)
        assert.lengthOf(yield* f.api.ListHistoryEdits({ chatId: f.chatId, forkId: f.main }), 0)
        assert.deepStrictEqual(yield* f.text(f.sibling), ["Aria meets ARIA and aria."])
      }
    }).pipe(Effect.provide(serverLayer(config)))
  )
  it.effect("search uses the editor's Unicode words and code points, preserving uncased replacements", () =>
    Effect.gen(function* () {
      const words = yield* scanHistory(["кошка кошкам кошка", "éAria Aria"], {
        ...search,
        preserveCase: false,
        pairs: [
          { find: "кошка", replace: "cat" },
          { find: "Aria", replace: "Ari" }
        ]
      })
      assert.strictEqual(words[0]!.after, "cat кошкам cat")
      assert.strictEqual(words[1]!.after, "éAria Ari")
      const points = yield* scanHistory(["😀"], {
        ...search,
        regex: true,
        wholeWord: false,
        preserveCase: false,
        pairs: [{ find: ".", replace: "x" }]
      })
      assert.strictEqual(points[0]!.after, "x")
      const uncased = yield* scanHistory(["."], {
        ...search,
        wholeWord: false,
        pairs: [{ find: ".", replace: "word" }]
      })
      assert.strictEqual(uncased[0]!.after, "word")
    })
  )
  it.effect("literal punctuation, captures, empty matches, invalid patterns and runaway regex", () =>
    Effect.gen(function* () {
      const literal = yield* scanHistory(["a.b axb"], {
        ...search,
        wholeWord: false,
        pairs: [{ find: "a.b", replace: "ok" }]
      })
      assert.strictEqual(literal[0]!.after, "ok axb")
      const groups = yield* scanHistory(["Aria"], {
        ...search,
        regex: true,
        preserveCase: false,
        pairs: [{ find: "(Ar)(ia)", replace: "$2$1 $$ $&" }]
      })
      assert.strictEqual(groups[0]!.after, "iaAr $ Aria")
      const empty = yield* scanHistory(["ab"], {
        ...search,
        regex: true,
        wholeWord: false,
        preserveCase: false,
        pairs: [{ find: "(?=b)", replace: "!" }]
      })
      assert.strictEqual(empty[0]!.after, "a!b")
      assert.strictEqual(
        yield* outcome(
          scanHistory(["abc"], { ...search, regex: true, pairs: [{ find: "(", replace: "" }] }),
          () => "allowed"
        ),
        "HistoryRejected"
      )
      assert.strictEqual(
        yield* outcome(
          scanHistory(["a".repeat(20000) + "!"], {
            ...search,
            regex: true,
            wholeWord: false,
            pairs: [{ find: "(a+)+$", replace: "" }]
          }),
          () => "allowed"
        ),
        "HistoryRejected"
      )
    })
  )
})

// Inserted messages (spec/MESSAGE-INSERT.md §3.3, unit 8): search walks the fork's display
// path, so an inserted message is in the history of the forks that show it and no other.
describe("history edits with inserted messages", () => {
  const insert = (f: Effect.Success<typeof setup>, forkId: ForkId, anchor: SlotId | null, content: string) =>
    Effect.map(
      f.writer.InsertMessage({
        userId: f.userId,
        chatId: f.chatId,
        forkId,
        anchorSlotId: anchor,
        expectedRowVersion: 0,
        body: { _tag: "Write", speaker: null, content }
      }),
      (made) => made.slotId
    )
  const append = (f: Effect.Success<typeof setup>, forkId: ForkId, parent: SlotId | null, content: string) =>
    Effect.map(
      f.writer.AppendMessage({
        userId: f.userId,
        chatId: f.chatId,
        forkId,
        parentSlotId: parent,
        branch: false,
        version: said(content),
        commitDraft: null
      }),
      (sent) => sent.slotId
    )
  const editsOf = (hits: ReadonlyArray<HistoryHit>) =>
    hits.map(({ kind, targetId, beforeId, before, after }) => ({ kind, targetId, beforeId, before, after }))
  /** Every page of a search, as the panel reads it. */
  const scan = (f: Effect.Success<typeof setup>, forkId: ForkId, find: HistorySearch) =>
    Effect.gen(function* () {
      const hits: Array<HistoryHit> = []
      let cursor: typeof HistoryCursor.Type | undefined
      do {
        const page = yield* f.api.PreviewHistory({
          chatId: f.chatId,
          forkId,
          search: find,
          ...(cursor ? { cursor } : {})
        })
        hits.push(...page.hits)
        cursor = page.next ?? undefined
      } while (cursor)
      return hits
    })

  it.effect("an insertion in another fork leaves the original hits, cost and changesets unchanged", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const preview = () => f.api.PreviewHistory({ chatId: f.chatId, forkId: f.main, search })
      const cost = () =>
        f.api.HistoryEditCost({ chatId: f.chatId, forkId: f.main, fromDepth: 0, retainedDepth: 0, summaryIds: [] })
      const before = yield* preview()
      const beforeCost = yield* cost()
      yield* insert(f, f.sibling, null, "Aria elsewhere")
      assert.deepStrictEqual(yield* preview(), before)
      assert.deepStrictEqual(yield* cost(), beforeCost)
      assert.deepStrictEqual(yield* f.api.ListHistoryEdits({ chatId: f.chatId, forkId: f.main }), [])
      yield* f.api.ApplyHistoryEdits({
        title: "Original path",
        applications: [{ chatId: f.chatId, forkId: f.main, edits: editsOf(before.hits) }]
      })
      const [record] = yield* f.api.ListHistoryEdits({ chatId: f.chatId, forkId: f.main })
      assert.strictEqual(record!.status, "applied")
      assert.deepStrictEqual(
        record!.items.map((item) => [item.targetId, item.before, item.after, item.applied]),
        before.hits.map((hit) => [hit.targetId, hit.before, hit.after, true])
      )
      assert.deepStrictEqual(yield* f.text(f.sibling), ["Aria elsewhere", "Aria meets ARIA and aria."])
    }).pipe(Effect.provide(serverLayer(config)))
  )

  it.effect("a match in an inserted message is replaced and undone in its fork only", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const b = yield* append(f, f.main, f.first.slotId, "Plain reply")
      // `sibling` was made at the first message before the insertion; `later` after it.
      const x = yield* insert(f, f.main, f.first.slotId, "Inserted Aria line")
      const later = (yield* f.writer.CreateFork({
        userId: f.userId,
        chatId: f.chatId,
        fromForkId: f.main,
        atSlotId: b
      })).fork.id
      const preview = yield* f.api.PreviewHistory({ chatId: f.chatId, forkId: f.main, search })
      // The first message's two versions, then X at position 1, in display order.
      assert.deepStrictEqual(
        preview.hits.map((h) => [h.slotId, h.depth, h.toDepth]),
        [
          [f.first.slotId, 0, 0],
          [f.first.slotId, 0, 0],
          [x, 1, 1]
        ]
      )
      const siblingPreview = yield* f.api.PreviewHistory({ chatId: f.chatId, forkId: f.sibling, search })
      assert.isFalse(siblingPreview.hits.some((h) => h.slotId === x))
      const xEdit = editsOf(preview.hits.filter((h) => h.slotId === x))
      // A fork that doesn't show X can't edit it, even naming its version.
      assert.strictEqual(
        yield* outcome(
          f.api.ApplyHistoryEdits({
            title: "Elsewhere",
            applications: [{ chatId: f.chatId, forkId: f.sibling, edits: xEdit }]
          })
        ),
        "NotFound"
      )
      const applied = yield* f.api.ApplyHistoryEdits({
        title: "Rename",
        applications: [{ chatId: f.chatId, forkId: f.main, edits: editsOf(preview.hits) }]
      })
      assert.deepStrictEqual(yield* f.text(f.main), ["Ari meets ARI and ari.", "Inserted Ari line", "Plain reply"])
      assert.deepStrictEqual(yield* f.text(f.sibling), ["Aria meets ARIA and aria."])
      // Made before the edit: it shows X, unedited.
      assert.deepStrictEqual(yield* f.text(later), ["Aria meets ARIA and aria.", "Inserted Aria line", "Plain reply"])
      const records = yield* f.api.ListHistoryEdits({ chatId: f.chatId, forkId: f.main })
      assert.isTrue(records[0]!.items.some((i) => i.slotId === x && i.applied))
      // Undoing X's message undoes only it, only here.
      const undo = yield* f.api.UndoHistoryEdit({
        chatId: f.chatId,
        forkId: f.main,
        changesetId: applied.changesetIds[0]!,
        slotId: x
      })
      assert.strictEqual(undo.undone, 1)
      assert.deepStrictEqual(yield* f.text(f.main), ["Ari meets ARI and ari.", "Inserted Aria line", "Plain reply"])
      assert.deepStrictEqual(yield* f.text(later), ["Aria meets ARIA and aria.", "Inserted Aria line", "Plain reply"])
      const status = yield* f.api.ListHistoryEdits({ chatId: f.chatId, forkId: f.main })
      assert.strictEqual(status[0]!.status, "partly undone")
      // The estimate counts from X's position: X and the reply after it.
      const cost = yield* f.api.HistoryEditCost({
        chatId: f.chatId,
        forkId: f.main,
        fromDepth: 1,
        retainedDepth: 0,
        summaryIds: []
      })
      assert.strictEqual(cost.messages, 2)
    }).pipe(Effect.provide(serverLayer(config)))
  )

  it.effect("a summary of an inserted message is found where X is shown, by position", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const b = yield* append(f, f.main, f.first.slotId, "Plain reply")
      const x = yield* insert(f, f.main, b, "Inserted below the reply")
      const entry = (yield* f.reader.GetSlot({ userId: f.userId, slotId: x, forkId: f.main })).entry
      yield* completeFixture(
        config.dataDir,
        f.writer,
        f.userId,
        f.chatId,
        [{ slotId: x, versionId: entry.version.id, amendCount: 0 }],
        [],
        " Aria"
      )
      const summaries = { ...search, messages: false, swipes: false }
      const here = yield* f.api.PreviewHistory({ chatId: f.chatId, forkId: f.main, search: summaries })
      assert.deepStrictEqual(
        here.hits.map((h) => [h.kind, h.slotId, h.depth, h.toDepth]),
        [["summary_revision", x, 2, 2]]
      )
      const elsewhere = yield* f.api.PreviewHistory({ chatId: f.chatId, forkId: f.sibling, search: summaries })
      assert.lengthOf(elsewhere.hits, 0)
    }).pipe(Effect.provide(serverLayer(config)))
  )

  it.effect(
    "forks made at X retain isolated replacements and undo through lineage compaction",
    () =>
      Effect.gen(function* () {
        const f = yield* setup
        const x = yield* insert(f, f.main, f.first.slotId, "Inserted Aria line")
        const forkAt = (fromForkId: ForkId, atSlotId: SlotId) =>
          Effect.map(
            f.writer.CreateFork({ userId: f.userId, chatId: f.chatId, fromForkId, atSlotId }),
            (made) => made.fork.id
          )
        const before = yield* forkAt(f.main, x)
        const hits = (yield* scan(f, f.main, search)).filter((h) => h.slotId === x)
        const applied = yield* f.api.ApplyHistoryEdits({
          title: "Replace X",
          applications: [{ chatId: f.chatId, forkId: f.main, edits: editsOf(hits) }]
        })
        const without = yield* forkAt(f.main, f.first.slotId)
        let descendant = f.main
        for (let i = 0; i < 70; i++) descendant = yield* forkAt(descendant, x)
        const [lineage] = yield* fixtureSql(
          config.dataDir,
          [{ sql: "SELECT json_array_length(lineage_json) AS n FROM forks WHERE id=?", params: [descendant] }],
          { readOnly: true }
        )
        assert.isBelow(lineage![0]!.n as number, 64)
        assert.deepStrictEqual(yield* f.text(descendant), ["Aria meets ARIA and aria.", "Inserted Ari line"])
        assert.deepStrictEqual(yield* f.text(before), ["Aria meets ARIA and aria.", "Inserted Aria line"])
        assert.isFalse((yield* scan(f, without, search)).some((h) => h.slotId === x))
        assert.isFalse((yield* f.api.ListHistoryEdits({ chatId: f.chatId, forkId: without }))[0]!.items[0]!.applied)
        assert.strictEqual(
          yield* outcome(
            f.api.ApplyHistoryEdits({
              title: "Hidden X",
              applications: [{ chatId: f.chatId, forkId: without, edits: editsOf(hits) }]
            })
          ),
          "NotFound"
        )
        const hiddenUndo = yield* f.api.UndoHistoryEdit({
          chatId: f.chatId,
          forkId: without,
          changesetId: applied.changesetIds[0]!
        })
        assert.strictEqual(hiddenUndo.undone, 0)
        assert.lengthOf(hiddenUndo.conflicts, 1)
        const inherited = yield* f.api.ListHistoryEdits({ chatId: f.chatId, forkId: descendant })
        assert.strictEqual(inherited[0]!.status, "applied")
        assert.isTrue(inherited[0]!.inherited)
        assert.strictEqual(
          (yield* f.api.UndoHistoryEdit({
            chatId: f.chatId,
            forkId: descendant,
            changesetId: applied.changesetIds[0]!
          })).undone,
          1
        )
        assert.deepStrictEqual(yield* f.text(descendant), ["Aria meets ARIA and aria.", "Inserted Aria line"])
        assert.deepStrictEqual(yield* f.text(f.main), ["Aria meets ARIA and aria.", "Inserted Ari line"])
        assert.strictEqual((yield* scan(f, descendant, search)).filter((h) => h.slotId === x).length, 1)
        assert.strictEqual(
          (yield* f.api.ListHistoryEdits({ chatId: f.chatId, forkId: descendant }))[0]!.status,
          "undone"
        )
      }).pipe(Effect.provide(serverLayer(config))),
    60_000
  )

  // Random appends, insertions, forks and deletions over a path longer than a window: every
  // fork's search finds its shown messages in display order with their positions, as its path
  // read (unit 3, checked against the display path oracle) shows them, and the estimate
  // counts from a position.
  for (const seed of [11, 29]) {
    it.effect(
      `search follows each fork's display path (seed ${seed})`,
      () =>
        Effect.gen(function* () {
          const f = yield* setup
          let state = seed
          const random = (n: number) => {
            state = (state * 1103515245 + 12345) % 2147483648
            return Math.floor((state / 2147483648) * n)
          }
          const tips = new Map<ForkId, SlotId>([
            [f.main, f.first.slotId],
            [f.sibling, f.first.slotId]
          ])
          let n = 0
          for (let i = 0; i < 104; i++) tips.set(f.main, yield* append(f, f.main, tips.get(f.main)!, `Aria ${n++}`))
          const shown = (forkId: ForkId) =>
            Effect.map(
              f.reader.GetPath({ userId: f.userId, chatId: f.chatId, forkId, leafSlotId: null, limit: 1000 }),
              (p) => p.entries
            )
          for (let op = 0; op < 60; op++) {
            const forks = [...tips.keys()]
            const forkId = forks[random(forks.length)]!
            const entries = yield* shown(forkId)
            const at = entries[random(entries.length)]
            const kind = random(10)
            if (kind < 3) tips.set(forkId, yield* append(f, forkId, tips.get(forkId)!, `Aria ${n++}`))
            else if (kind < 7)
              yield* insert(f, forkId, kind === 3 || at === undefined ? null : at.slotId, `Aria ${n++}`)
            else if (kind < 9 && at !== undefined) {
              const made = yield* f.writer.CreateFork({
                userId: f.userId,
                chatId: f.chatId,
                fromForkId: forkId,
                atSlotId: at.slotId
              })
              tips.set(made.fork.id, at.slotId)
            } else if (at !== undefined && at.slotId !== tips.get(forkId))
              yield* f.writer.DeleteMessage({ userId: f.userId, slotId: at.slotId, forkId })
          }
          const messages = { ...search, pairs: [{ find: "Aria", replace: "Ari" }], swipes: false, summaries: false }
          for (const forkId of tips.keys()) {
            const entries = (yield* shown(forkId)).filter((e) => e.version.content.includes("Aria"))
            const hits = yield* scan(f, forkId, messages)
            assert.deepStrictEqual(
              hits.map((h) => [h.slotId, h.depth]),
              entries.map((e) => [e.slotId, e.position!]),
              `fork ${forkId}`
            )
            const from = entries[random(entries.length)]!.position!
            const cost = yield* f.api.HistoryEditCost({
              chatId: f.chatId,
              forkId,
              fromDepth: from,
              retainedDepth: 0,
              summaryIds: []
            })
            const all = yield* shown(forkId)
            assert.strictEqual(cost.messages, all.filter((e) => e.position! >= from).length)
          }
        }).pipe(Effect.provide(serverLayer(config))),
      60_000
    )
  }
})
