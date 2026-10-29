import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { client, outcome, posted, serverLayer, testConfig } from "./support/config.ts"

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
      assert.strictEqual(history.length, 2)
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
      assert.deepStrictEqual(
        (yield* api.MessageDraftHistory({ target, limit: 1000 })).map((s) => s.length),
        [0]
      )
    }
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)
