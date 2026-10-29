import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Database from "../src/db/Database.ts"
import { tempDir } from "./support/tempDir.ts"

const layer = () =>
  Database.layer({ dataDir: tempDir("user-drafts"), readers: 1, workers: "source", allowNetworkFs: false })

describe("authored settings and pre-creation drafts", () => {
  it.effect("persists field undo, isolates account keys and recovers destructive and discarded text", () =>
    Effect.gen(function* () {
      const writer = yield* Database.Writer
      const reader = yield* Database.Reader
      const user = yield* writer.EnsureUser({ handle: "draft-author", displayName: "Author" })
      const other = yield* writer.EnsureUser({ handle: "other-author", displayName: "Other" })
      const key = {
        targetKind: "user_field" as const,
        targetId: "Settings → Chats",
        field: "Summarization instruction"
      }
      const first = yield* writer.SaveDraft({
        userId: user.id,
        key,
        content: "Keep the synthetic keeper's promises and debts.",
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        baseRevision: null
      })
      const changed = yield* writer.SaveDraft({
        userId: user.id,
        key,
        content: "x",
        draftId: first.id,
        expectedRowVersion: first.rowVersion,
        expectedSession: first.session,
        baseRevision: null
      })
      assert.strictEqual((yield* reader.GetDraft({ userId: user.id, key }))?.content, "x")
      assert.isNull(yield* reader.GetDraft({ userId: other.id, key }))
      const history = yield* reader.DraftHistory({ userId: user.id, key, limit: 100 })
      assert.strictEqual(history.length, 2)
      const restored = yield* writer.RestoreDraftState({
        userId: user.id,
        key,
        draftId: first.id,
        seq: history[1]!.seq,
        expectedRowVersion: changed.rowVersion
      })
      assert.strictEqual(restored.content, first.content)
      const ended = yield* writer.ClearDraft({
        userId: user.id,
        key,
        draftId: first.id,
        expectedRowVersion: restored.rowVersion,
        outcome: "discarded"
      })
      assert.strictEqual(ended.status, "discarded")
      const recovered = yield* reader.ListRecoveredTexts({ userId: user.id, source: null, limit: 100, before: null })
      assert.isTrue(recovered.some((text) => text.content === first.content))
    }).pipe(Effect.provide(layer()))
  )

  it.effect("keeps fork, connection, model and pending scopes independent and ends only the named draft version", () =>
    Effect.gen(function* () {
      const writer = yield* Database.Writer
      const reader = yield* Database.Reader
      const user = yield* writer.EnsureUser({ handle: "scope-author", displayName: "Author" })
      for (const targetId of [
        "chat:a:fork:one",
        "chat:a:fork:two",
        "connection:new",
        "model:one",
        "pending-chat:card"
      ]) {
        const key = { targetKind: "user_field" as const, targetId, field: "Text" }
        const first = yield* writer.SaveDraft({
          userId: user.id,
          key,
          content: targetId,
          draftId: null,
          expectedRowVersion: null,
          expectedSession: null,
          baseRevision: null
        })
        const next = yield* writer.SaveDraft({
          userId: user.id,
          key,
          content: `${targetId} later`,
          draftId: first.id,
          expectedRowVersion: first.rowVersion,
          expectedSession: first.session,
          baseRevision: null
        })
        const end = yield* Effect.result(
          writer.ClearDraft({
            userId: user.id,
            key,
            draftId: first.id,
            expectedRowVersion: first.rowVersion,
            outcome: "committed"
          })
        )
        assert.strictEqual(end._tag, "Failure")
        assert.strictEqual((yield* reader.GetDraft({ userId: user.id, key }))?.content, next.content)
        yield* writer.ClearDraft({
          userId: user.id,
          key,
          draftId: next.id,
          expectedRowVersion: next.rowVersion,
          outcome: "committed"
        })
        assert.strictEqual((yield* reader.DraftHistory({ userId: user.id, key, limit: 100 })).length, 1)
      }
    }).pipe(Effect.provide(layer()))
  )
})

describe("compound setting fields", () => {
  it.effect("keeps a short field before a destructive edit even when another field dominates the form", () =>
    Effect.gen(function* () {
      const writer = yield* Database.Writer
      const reader = yield* Database.Reader
      const user = yield* writer.EnsureUser({ handle: "field-author", displayName: "Author" })
      const key = { targetKind: "user_field" as const, targetId: "connection:synthetic", field: "Settings" }
      const prose = "The keeper remembers every promise made at the lighthouse and every debt still unpaid."
      const content = (name: string) =>
        JSON.stringify({ name, baseUrl: `https://synthetic.invalid/${"padding".repeat(500)}` })
      let draft = yield* writer.SaveDraft({
        userId: user.id,
        key,
        content: content(""),
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        baseRevision: null
      })
      for (const name of [prose, "x"])
        draft = yield* writer.SaveDraft({
          userId: user.id,
          key,
          content: content(name),
          draftId: draft.id,
          expectedRowVersion: draft.rowVersion,
          expectedSession: draft.session,
          baseRevision: null
        })
      const history = yield* reader.DraftHistory({ userId: user.id, key, limit: 100 })
      const texts = yield* Effect.forEach(history, (state) =>
        reader.GetDraftState({ userId: user.id, key, seq: state.seq })
      )
      assert.isTrue(texts.some((state) => state.content === content(prose)))
      yield* writer.ClearDraft({
        userId: user.id,
        key,
        draftId: draft.id,
        expectedRowVersion: draft.rowVersion,
        outcome: "committed"
      })
      const recovered = yield* reader.ListRecoveredTexts({ userId: user.id, source: key, limit: 100, before: null })
      const full = yield* Effect.forEach(recovered, (text) => reader.GetRecoveredText({ userId: user.id, id: text.id }))
      assert.isTrue(full.some((text) => text.content === content(prose)))
    }).pipe(Effect.provide(layer()))
  )
})

it.effect("does not coalesce edits of different fields in a settings form", () =>
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const user = yield* writer.EnsureUser({ handle: "separate-fields", displayName: "Author" })
    const key = { targetKind: "user_field" as const, targetId: "connection:synthetic", field: "Settings" }
    const start = JSON.stringify({ name: "", baseUrl: "https://old.invalid" })
    const named = JSON.stringify({ name: "An unfinished name", baseUrl: "https://old.invalid" })
    const addressed = JSON.stringify({ name: "An unfinished name", baseUrl: "https://next.invalid" })
    let draft = yield* writer.SaveDraft({
      userId: user.id,
      key,
      content: start,
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      baseRevision: null
    })
    for (const content of [named, addressed])
      draft = yield* writer.SaveDraft({
        userId: user.id,
        key,
        content,
        draftId: draft.id,
        expectedRowVersion: draft.rowVersion,
        expectedSession: draft.session,
        baseRevision: null
      })
    const history = yield* reader.DraftHistory({ userId: user.id, key, limit: 100 })
    const texts = yield* Effect.forEach(history, (state) =>
      reader.GetDraftState({ userId: user.id, key, seq: state.seq })
    )
    const previous = texts.find((state) => state.content === named)
    assert.isDefined(previous)
    const restored = yield* writer.RestoreDraftState({
      userId: user.id,
      key,
      draftId: draft.id,
      expectedRowVersion: draft.rowVersion,
      seq: previous!.seq
    })
    assert.strictEqual(restored.content, named)
  }).pipe(Effect.provide(layer()))
)
