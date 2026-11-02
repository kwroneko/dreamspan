import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Database from "../src/db/Database.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const layer = () =>
  Database.layer({ dataDir: tempDir("user-drafts"), readers: 1, ...testWorkers, allowNetworkFs: false })

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
      assert.strictEqual(ended.content, "")
      assert.strictEqual(ended.clearedVersion, ended.rowVersion)
      const tombstone = yield* reader.GetDraft({ userId: user.id, key })
      assert.strictEqual(tombstone?.updatedAt, ended.updatedAt)
      assert.strictEqual(tombstone?.clearedVersion, ended.rowVersion)
      const recovered = yield* reader.ListRecoveredTexts({ userId: user.id, source: null, limit: 100, before: null })
      assert.isTrue(recovered.some((text) => text.content === first.content))
    }).pipe(Effect.provide(layer()))
  )

  it.effect("keeps a versioned empty tombstone through later typing", () =>
    Effect.gen(function* () {
      const writer = yield* Database.Writer
      const reader = yield* Database.Reader
      const user = yield* writer.EnsureUser({ handle: "empty-author", displayName: "Author" })
      const key = { targetKind: "user_field" as const, targetId: "pending-chat:synthetic", field: "First message" }
      let current = yield* writer.SaveDraft({
        userId: user.id,
        key,
        content: "delete this",
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        baseRevision: null
      })
      current = yield* writer.SaveDraft({
        userId: user.id,
        key,
        content: "",
        draftId: current.id,
        expectedRowVersion: current.rowVersion,
        expectedSession: current.session,
        baseRevision: null
      })
      assert.strictEqual(current.clearedVersion, current.rowVersion)
      const cleared = current.rowVersion
      const stale = yield* writer.SaveDraft({
        userId: user.id,
        key,
        content: "old device copy",
        draftId: current.id,
        expectedRowVersion: cleared - 1,
        expectedSession: current.session,
        baseRevision: null
      })
      assert.strictEqual(stale.content, "")
      assert.strictEqual(stale.rowVersion, cleared)
      assert.strictEqual(stale.recovered, 1)
      const read = yield* reader.GetDraft({ userId: user.id, key })
      assert.strictEqual(read?.content, "")
      assert.strictEqual(read?.updatedAt, current.updatedAt)
      current = yield* writer.SaveDraft({
        userId: user.id,
        key,
        content: "a new thought",
        draftId: current.id,
        expectedRowVersion: current.rowVersion,
        expectedSession: current.session,
        baseRevision: null
      })
      assert.strictEqual(current.clearedVersion, cleared)
    }).pipe(Effect.provide(layer()))
  )

  it.effect("only an observation of the latest deletion permits new text on an older drafting base", () =>
    Effect.gen(function* () {
      const writer = yield* Database.Writer
      const user = yield* writer.EnsureUser({ handle: "observed-clear", displayName: "Author" })
      const key = { targetKind: "user_field" as const, targetId: "pending-chat:observed", field: "First message" }
      const first = yield* writer.SaveDraft({
        userId: user.id,
        key,
        content: "before",
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        baseRevision: null
      })
      const base = {
        userId: user.id,
        key,
        draftId: first.id,
        expectedRowVersion: first.rowVersion,
        expectedSession: first.session,
        baseRevision: null
      }
      const deleted = yield* writer.SaveDraft({ ...base, content: "" })
      const seen = { draftId: deleted.id, rowVersion: deleted.rowVersion }
      const fresh = yield* writer.SaveDraft({ ...base, content: "new after observing", observedDeletion: seen })
      assert.strictEqual(fresh.content, "new after observing")
      const later = yield* writer.SaveDraft({ ...base, content: "", expectedRowVersion: fresh.rowVersion })
      for (const observedDeletion of [seen, { draftId: "another-draft", rowVersion: later.rowVersion + 100 }]) {
        const stale = yield* writer.SaveDraft({ ...base, content: "stale browser copy", observedDeletion })
        assert.strictEqual(stale.content, "")
        assert.strictEqual(stale.recovered, 1)
      }
      const newest = yield* writer.SaveDraft({
        ...base,
        content: "new after the second deletion",
        observedDeletion: { draftId: later.id, rowVersion: later.rowVersion }
      })
      assert.strictEqual(newest.content, "new after the second deletion")
      assert.strictEqual(newest.clearedVersion, later.rowVersion)
    }).pipe(Effect.provide(layer()))
  )

  it.effect("a normal form commit leaves later typing free to start a new session", () =>
    Effect.gen(function* () {
      const writer = yield* Database.Writer
      const user = yield* writer.EnsureUser({ handle: "new-form-author", displayName: "Author" })
      const key = { targetKind: "user_field" as const, targetId: "chat:new", field: "Title" }
      const first = yield* writer.SaveDraft({
        userId: user.id,
        key,
        content: "First chat",
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        baseRevision: null
      })
      const ended = yield* writer.ClearDraft({
        userId: user.id,
        key,
        draftId: first.id,
        expectedRowVersion: first.rowVersion,
        outcome: "committed"
      })
      assert.strictEqual(ended.clearedVersion, 0)
      const later = yield* writer.SaveDraft({
        userId: user.id,
        key,
        content: "New chat typed before the draft read",
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        baseRevision: null
      })
      assert.strictEqual(later.content, "New chat typed before the draft read")
      assert.strictEqual(later.recovered, 0)
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
