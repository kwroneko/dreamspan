import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { DraftHistoryPolicy, DraftKey } from "@rp/shared/drafts.ts"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { client, outcome, posted, serverLayer, testConfig } from "./support/config.ts"
import { completeFixture } from "./support/lcmFixtures.ts"
import { slowIt } from "./support/slow.ts"

it.live("saved amendments restore optimistically in one fork and retain both histories", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const chat = yield* api.CreateChat({ title: "Synthetic history" })
    const main = chat.currentForkId!
    const sent = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "original" })
    )
    const versionId = sent.entry.version.id
    const amended = yield* api.AmendVersion({ versionId, forkId: main, content: "second", expectedRowVersion: 1 })
    const history = yield* api.VersionAmendments({ versionId })
    assert.deepStrictEqual(
      history.map((s) => s.content),
      ["original"]
    )
    const otherChat = yield* api.CreateChat({ title: "Wrong fork" })
    assert.strictEqual(
      yield* outcome(
        api.RestoreVersionAmendment({
          versionId,
          amendmentId: history[0]!.id,
          forkId: otherChat.currentForkId!,
          expectedRowVersion: amended.rowVersion
        })
      ),
      "NotFound"
    )
    const sibling = (yield* api.CreateFork({ chatId: chat.id, fromForkId: main, atSlotId: sent.entry.slotId })).fork.id
    const restored = yield* api.RestoreVersionAmendment({
      versionId,
      amendmentId: history[0]!.id,
      forkId: main,
      expectedRowVersion: amended.rowVersion
    })
    assert.strictEqual(restored.content, "original")
    assert.notStrictEqual(restored.id, versionId)
    assert.deepStrictEqual(
      (yield* api.VersionAmendments({ versionId: restored.id })).map((s) => s.content),
      ["second", "original"]
    )
    assert.deepStrictEqual(
      (yield* api.VersionAmendments({ versionId })).map((s) => s.content),
      ["original"]
    )
    assert.strictEqual((yield* api.ListVersions({ slotId: sent.entry.slotId, forkId: sibling }))[0]!.content, "second")
    assert.strictEqual(
      yield* outcome(
        api.RestoreVersionAmendment({
          versionId,
          amendmentId: history[0]!.id,
          forkId: main,
          expectedRowVersion: amended.rowVersion
        })
      ),
      "StaleWrite"
    )
    assert.strictEqual(
      yield* outcome(
        api.RestoreVersionAmendment({
          versionId: restored.id,
          amendmentId: -1,
          forkId: main,
          expectedRowVersion: restored.rowVersion
        })
      ),
      "NotFound"
    )
    // Undoing the restore is itself a normal amendment, with no extra swipe.
    const second = (yield* api.VersionAmendments({ versionId: restored.id }))[0]!
    const undone = yield* api.RestoreVersionAmendment({
      versionId: restored.id,
      amendmentId: second.id,
      forkId: main,
      expectedRowVersion: restored.rowVersion
    })
    assert.strictEqual(undone.content, "second")
    assert.strictEqual((yield* api.ListVersions({ slotId: sent.entry.slotId, forkId: main })).length, 1)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("message edit and scratchpad history survive reopening, restore and end with the draft session", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const chat = yield* api.CreateChat({ title: "Synthetic drafts" })
    const sent = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "original" })
    )
    for (const target of [
      { _tag: "Edit", versionId: sent.entry.version.id } as const,
      { _tag: "Write", slotId: sent.entry.slotId } as const
    ]) {
      const first = yield* api.SaveMessageDraft({
        target,
        draftId: null,
        content: "Long draft before an accidental overwrite. ".repeat(20),
        expectedRowVersion: null,
        expectedSession: null
      })
      const second = yield* api.SaveMessageDraft({
        target,
        draftId: first.id,
        content: "oops",
        expectedRowVersion: first.rowVersion,
        expectedSession: first.session
      })
      const history = yield* api.MessageDraftHistory({ target, limit: 1000 })
      // An edit's first state is the version's text (owner, 2026-11-02).
      assert.strictEqual(history.length, target._tag === "Edit" ? 3 : 2)
      const reopened = (yield* api.MessageDrafts({ chatId: chat.id })).find((d) => d.id === first.id)!
      const restored = yield* api.RestoreMessageDraft({
        target,
        draftId: reopened.id,
        seq: history[1]!.seq,
        expectedRowVersion: reopened.rowVersion
      })
      assert.strictEqual(restored.content, first.content)
      assert.strictEqual(
        yield* outcome(
          api.RestoreMessageDraft({
            target,
            draftId: second.id,
            seq: history[0]!.seq,
            expectedRowVersion: second.rowVersion
          })
        ),
        "StaleWrite"
      )
      const undo = yield* api.RestoreMessageDraft({
        target,
        draftId: restored.id,
        seq: history[0]!.seq,
        expectedRowVersion: restored.rowVersion
      })
      assert.strictEqual(undo.content, "oops")
      const switched = yield* api.RestoreMessageDraft({
        target,
        draftId: undo.id,
        seq: 0,
        content: "Other tab's recovered text",
        expectedRowVersion: undo.rowVersion
      })
      assert.strictEqual(switched.content, "Other tab's recovered text")
      yield* api.DiscardMessageDraft({ target, draftId: switched.id, expectedRowVersion: switched.rowVersion })
      const left = yield* api.MessageDraftHistory({ target, limit: 1000 })
      // An edit's cancel goes back to the version's text, the cancelled text one step back;
      // a written version's session ends with its history.
      if (target._tag === "Edit")
        assert.deepStrictEqual(
          left.slice(0, 2).map((s) => [s.kind, s.length]),
          [
            ["revision", "original".length],
            ["restore", "Other tab's recovered text".length]
          ]
        )
      else
        assert.deepStrictEqual(
          left.map((s) => s.length),
          [0]
        )
    }
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

for (const kind of ["edit", "write", "summary"] as const) {
  const config = testConfig()
  slowIt.live(`${kind} history exposes the oldest retained text at the patch limit`, () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const user = yield* api.Whoami()
      const chat = yield* api.CreateChat({ title: "Synthetic full history" })
      const sent = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "original" })
      )
      const summary = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [
        { slotId: sent.entry.slotId, versionId: sent.entry.version.id, amendCount: 0 }
      ])
      const summaryKey = { forkId: chat.currentForkId!, summaryId: summary.id }
      const target =
        kind === "edit"
          ? ({ _tag: "Edit", versionId: sent.entry.version.id } as const)
          : ({ _tag: "Write", slotId: sent.entry.slotId } as const)
      const save = {
        draftId: null,
        content: "Oldest retained text",
        expectedRowVersion: null,
        expectedSession: null
      }
      let draft = yield* kind === "summary"
        ? api.SaveSummaryDraft({ ...summaryKey, ...save, baseRevisionId: summary.revisionId })
        : api.SaveMessageDraft({ target, ...save })
      const initial = draft.content
      // Restores never coalesce. Exercise the real writer's retention boundary without a
      // wall-clock wait, keeping all database work in its worker.
      for (let n = 0; n < DraftHistoryPolicy.maxEntries; n++)
        draft = yield* writer.RestoreDraftState({
          userId: user.id,
          key: new DraftKey(draft.key),
          draftId: draft.id,
          seq: 0,
          content: `Retained state ${n}`,
          expectedRowVersion: draft.rowVersion
        })
      const limit = DraftHistoryPolicy.maxEntries + 1
      const page = (before?: number) => {
        const more = before === undefined ? {} : { before }
        return kind === "summary"
          ? api.SummaryDraftHistory({ ...summaryKey, limit, ...more })
          : api.MessageDraftHistory({ target, limit, ...more })
      }
      let states = yield* page()
      assert.strictEqual(states.length, limit)
      // A message's or a summary's edit keeps whichever is more, its last 200 states or its
      // last 30 days (owner, 2026-11-02), so nothing here was dropped: the history starts at
      // the text the edit was typed on, the page before reached with `before`.
      if (kind !== "write") {
        states = [...states, ...(yield* page(states.at(-1)!.seq))]
        assert.strictEqual(states.length, DraftHistoryPolicy.maxEntries + 2)
      }
      assert.strictEqual(states.at(-1)!.kind, "initial")
      const restore = {
        draftId: draft.id,
        seq: states.at(-1)!.seq,
        expectedRowVersion: draft.rowVersion
      }
      const restored = yield* kind === "summary"
        ? api.RestoreSummaryDraft({ ...summaryKey, ...restore })
        : api.RestoreMessageDraft({ target, ...restore })
      assert.strictEqual(
        restored.content,
        kind === "write" ? initial : kind === "edit" ? "original" : (summary.content ?? "")
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  )
}
