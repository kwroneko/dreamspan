// A form's save from an out-of-date tab is refused, never merged (owner, 2026-11-24;
// ARCHITECTURE §3.10 "Forms refuse stale saves"). The scenarios are the model mass edit's from
// the review of e05f7b2b0 (P1 1 and 2), where the field merge kept the wrong values: now the
// draft keeps the current version whole, the stale one is one step behind it in the field's
// history, and saving it again on the current version (the tab's "Use this tab's version")
// makes it current with the replaced one a step behind. Nothing is lost.
import { assert, describe, it } from "@effect/vitest"
import type { Draft } from "@dreamspan/shared/drafts.ts"
import { Effect } from "effect"
import * as Database from "../src/db/Database.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const layer = () =>
  Database.layer({ dataDir: tempDir("form-refuse"), readers: 1, ...testWorkers, allowNetworkFs: false })

const key = { targetKind: "user_field" as const, targetId: "model-mass-edit:2-synthetic", field: "Edit models" }
const ids = ["model-a", "model-b"]
const form = (value: object) => JSON.stringify(value)

const setup = (handle: string) =>
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const user = yield* writer.EnsureUser({ handle, displayName: "Author" })
    const save = (content: string, on: Draft | null, extra: { seed?: boolean } = {}) =>
      writer.SaveDraft({
        userId: user.id,
        key,
        content,
        draftId: on?.id ?? null,
        expectedRowVersion: on?.rowVersion ?? null,
        expectedSession: on?.session ?? null,
        baseRevision: null,
        ...extra
      })
    /** Every text the field's history can restore, newest first. */
    const states = () =>
      Effect.gen(function* () {
        const history = yield* reader.DraftHistory({ userId: user.id, key, limit: 100 })
        const texts: Array<string> = []
        for (const state of history.slice(1))
          texts.push((yield* reader.GetDraftState({ userId: user.id, key, seq: state.seq })).content)
        return texts
      })
    return { writer, reader, user, save, states }
  })

/** The refusal's shape: the current version kept, the stale one named and one step behind it. */
const assertRefused = (refused: Draft, current: Draft, stale: string) => {
  assert.strictEqual(refused.content, current.content)
  assert.strictEqual(refused.rowVersion, current.rowVersion)
  assert.strictEqual(refused.refused?.content, stale)
}

describe("a stale form save is refused and the current version kept", () => {
  it.effect("P1 1: a legacy tick list and text draft, Context typed in A and Reply length in B", () =>
    Effect.gen(function* () {
      const { save, reader, user, states } = yield* setup("refuse-ticks")
      // Stored by the older build: ticks as a list, the form's draft as JSON text.
      const start = yield* save(
        form({ ids, ticked: ["context"], draft: form({ context: "24000", maxOutput: "" }) }),
        null
      )
      const fromA = form({ ids, ticked: { context: true }, draft: { context: "50000", maxOutput: "" } })
      const a = yield* save(fromA, start)
      assert.strictEqual(a.content, fromA)
      assert.isUndefined(a.refused)
      // B replays from the shared start: Reply length 900 ticked, Context as it was.
      const fromB = form({
        ids,
        ticked: { context: true, maxOutput: true },
        draft: { context: "24000", maxOutput: "900" }
      })
      const b = yield* save(fromB, start)
      assertRefused(b, a, fromB)
      // A's Context and its tick stand exactly; nothing of B's is merged in.
      const kept = yield* reader.GetDraft({ userId: user.id, key })
      assert.strictEqual(kept?.content, fromA)
      // B's version is one step back, A's before it: both reachable.
      const texts = yield* states()
      assert.strictEqual(texts[0], fromB)
      assert.include(texts, fromA)
      // "Use this tab's version": B's version saved on the current one becomes the draft.
      const now = (yield* reader.GetDraft({ userId: user.id, key }))!
      const used = yield* save(fromB, now)
      assert.strictEqual(used.content, fromB)
      assert.isUndefined(used.refused)
      const after = yield* states()
      assert.strictEqual(after[0], fromA)
    }).pipe(Effect.provide(layer()))
  )

  it.effect("P1 1: an untick in A and an independent tick in B, and a queued legacy list from B", () =>
    Effect.gen(function* () {
      const { save, reader, user } = yield* setup("refuse-untick")
      const start = yield* save(form({ ids, ticked: ["context", "maxOutput"], draft: null }), null)
      const fromA = form({ ids, ticked: { maxOutput: true }, draft: null })
      const a = yield* save(fromA, start)
      const tickInB = form({ ids, ticked: { context: true, maxOutput: true, temperature: true }, draft: null })
      assertRefused(yield* save(tickInB, start), a, tickInB)
      // A queued pre-upgrade save, its ticks still a list.
      const legacyB = form({ ids, ticked: ["context", "maxOutput", "temperature"], draft: null })
      assertRefused(yield* save(legacyB, start), a, legacyB)
      assert.strictEqual((yield* reader.GetDraft({ userId: user.id, key }))?.content, fromA)
    }).pipe(Effect.provide(layer()))
  )

  it.effect("P1 2: a tick-only draft with no values, Context typed in A, Reply length replayed from B", () =>
    Effect.gen(function* () {
      const { save, reader, user, states } = yield* setup("refuse-null")
      const start = yield* save(form({ ids, ticked: { context: true }, draft: null }), null)
      // A types Context 50000: its draft is the whole form, numbers and text together.
      const fromA = form({ ids, ticked: { context: true }, draft: { context: "50000", maxOutput: "" } })
      const a = yield* save(fromA, start)
      const fromB = form({
        ids,
        ticked: { context: true, maxOutput: true },
        draft: { context: "24000", maxOutput: "900" }
      })
      assertRefused(yield* save(fromB, start), a, fromB)
      // The kept draft says 50000 throughout: no old 24000 under a 50000 shown.
      const kept = (yield* reader.GetDraft({ userId: user.id, key }))!
      assert.deepStrictEqual(JSON.parse(kept.content), JSON.parse(fromA))
      assert.strictEqual((yield* states())[0], fromB)
    }).pipe(Effect.provide(layer()))
  )

  it.effect("both queued writes still legacy text: the second is refused, Context 24000 not restored", () =>
    Effect.gen(function* () {
      const { save, reader, user } = yield* setup("refuse-text")
      const start = yield* save(form({ ids, ticked: ["context"], draft: form({ context: "24000" }) }), null)
      const fromA = form({ ids, ticked: ["context"], draft: form({ context: "50000" }) })
      const a = yield* save(fromA, start)
      const fromB = form({ ids, ticked: ["context", "maxOutput"], draft: form({ context: "24000", maxOutput: "900" }) })
      assertRefused(yield* save(fromB, start), a, fromB)
      assert.strictEqual((yield* reader.GetDraft({ userId: user.id, key }))?.content, fromA)
    }).pipe(Effect.provide(layer()))
  )

  it.effect("a refused stale version reaches the recovered texts if the form is discarded without it", () =>
    Effect.gen(function* () {
      const { save, writer, reader, user } = yield* setup("refuse-discard")
      const start = yield* save(form({ ids, ticked: {}, draft: null }), null)
      const a = yield* save(form({ ids, ticked: { context: true }, draft: { context: "50000" } }), start)
      const fromB = form({ ids, ticked: { maxOutput: true }, draft: { maxOutput: "900" } })
      yield* save(fromB, start)
      yield* writer.ClearDraft({
        userId: user.id,
        key,
        draftId: a.id,
        expectedRowVersion: (yield* reader.GetDraft({ userId: user.id, key }))!.rowVersion,
        outcome: "discarded"
      })
      const recovered = yield* reader.ListRecoveredTexts({ userId: user.id, source: null, limit: 100, before: null })
      assert.isTrue(recovered.some((text) => text.content === fromB))
    }).pipe(Effect.provide(layer()))
  )

  it.effect("refuses a save from an ended session when a newer form is active", () =>
    Effect.gen(function* () {
      const { save, writer, user, states } = yield* setup("refuse-old-session")
      const start = yield* save(form({ name: "First form", note: "" }), null)
      const ended = yield* writer.ClearDraft({
        userId: user.id,
        key,
        draftId: start.id,
        expectedRowVersion: start.rowVersion,
        outcome: "committed"
      })
      const current = yield* save(form({ name: "Second form", note: "" }), start)
      assert.strictEqual(current.status, "active")
      assert.strictEqual(current.session, ended.session)
      assert.isUndefined(current.refused)
      const stale = form({ name: "First form", note: "Old tab's edit" })

      assertRefused(yield* save(stale, start), current, stale)
      assert.strictEqual((yield* states())[0], stale)
    }).pipe(Effect.provide(layer()))
  )

  it.effect("retains history against the active form without evicting unrelated recovered text", () =>
    Effect.gen(function* () {
      const { save, writer, reader, user, states } = yield* setup("refuse-retention")
      yield* writer.ChangeBinLimit({ userId: user.id, key: "recoveredTexts", value: 2 })
      const unrelatedKey = { ...key, targetId: "unrelated-draft" }
      const unrelated = yield* writer.SaveDraft({
        userId: user.id,
        key: unrelatedKey,
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        baseRevision: null,
        content: "Only recovered copy of an unrelated draft"
      })
      yield* writer.ClearDraft({
        userId: user.id,
        key: unrelatedKey,
        draftId: unrelated.id,
        expectedRowVersion: unrelated.rowVersion,
        outcome: "discarded"
      })
      const activeText = form({ note: "A".repeat(250_000) })
      const first = yield* save(activeText, null)
      const second = yield* save(form({ note: "B".repeat(100_000) }), first)
      const current = yield* save(activeText, second)
      const stale = form({ note: "C".repeat(100_000) })

      const refused = yield* save(stale, second)
      assertRefused(refused, current, stale)
      assert.strictEqual(refused.recovered, 1)
      assert.strictEqual((yield* states())[0], stale)
      const recovered = yield* reader.ListRecoveredTexts({ userId: user.id, source: null, limit: 100, before: null })
      const full = yield* Effect.forEach(recovered, (entry) =>
        reader.GetRecoveredText({ userId: user.id, id: entry.id })
      )
      assert.sameMembers(
        full.map((entry) => entry.content),
        [second.content, unrelated.content]
      )
    }).pipe(Effect.provide(layer()))
  )

  it.effect("a stale starting snapshot is refused without a history step; the current tab saves on", () =>
    Effect.gen(function* () {
      const { save, reader, user } = yield* setup("refuse-seed")
      const a = yield* save(form({ ids, ticked: { context: true }, draft: { context: "50000" } }), null)
      const before = (yield* reader.DraftHistory({ userId: user.id, key, limit: 100 })).length
      const seed = form({ ids, ticked: {}, draft: null })
      const refused = yield* save(seed, null, { seed: true })
      assertRefused(refused, a, seed)
      assert.strictEqual((yield* reader.DraftHistory({ userId: user.id, key, limit: 100 })).length, before)
      // The current version saves as before: its base is current, and the row's version didn't move.
      const next = form({ ids, ticked: { context: true }, draft: { context: "60000" } })
      assert.strictEqual((yield* save(next, a)).content, next)
    }).pipe(Effect.provide(layer()))
  )

  it.effect("plain text keeps its rule: a stale save goes on top, the other text a step back", () =>
    Effect.gen(function* () {
      const { writer, user } = yield* setup("text-on-top")
      const textKey = {
        targetKind: "user_field" as const,
        targetId: "Settings → Chats",
        field: "Summarization instruction"
      }
      const saveText = (content: string, on: Draft | null) =>
        writer.SaveDraft({
          userId: user.id,
          key: textKey,
          content,
          draftId: on?.id ?? null,
          expectedRowVersion: on?.rowVersion ?? null,
          expectedSession: on?.session ?? null,
          baseRevision: null
        })
      const start = yield* saveText("Synthetic instruction.", null)
      yield* saveText("Synthetic instruction, typed in A.", start)
      const b = yield* saveText("Synthetic instruction, typed in B.", start)
      assert.strictEqual(b.content, "Synthetic instruction, typed in B.")
      assert.isUndefined(b.refused)
      assert.strictEqual(b.displaced?.content, "Synthetic instruction, typed in A.")
    }).pipe(Effect.provide(layer()))
  )
})
