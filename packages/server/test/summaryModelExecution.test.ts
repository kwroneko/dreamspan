// Loopback synthetic provider only: prove the selected destination reaches execution and
// the saved summary's details, rather than merely inspecting a model binding.
import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"

lcmTest("summary execution and saved writer follow account and chat choices, then clearing", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server)
    const at = h.rows.at(-1)!.slotId
    yield* h.api.ChangeGenerationDefaults({ change: { summarizer: h.fallback } })
    const run = (from: number, to: number, key: string) =>
      Effect.gen(function* () {
        yield* h.enqueue(from, to)
        yield* h.runNext
        const state = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: at })
        const made = state.layer.find((s) => s.firstSlotId === h.rows[from]!.slotId)
        assert.isDefined(made)
        const details = yield* h.api.GetSummaryDetails({ summaryId: made!.id })
        assert.strictEqual(details.model, key)
        assert.strictEqual(h.mock.requests().at(-1)!.body?.model, key)
      })
    yield* run(0, 1, "fallback-model")
    yield* h.api.ChangeCast({
      chatId: h.chat.id,
      slotId: h.rows[2]!.slotId,
      change: { _tag: "SummaryModel", model: h.primary }
    })
    yield* run(2, 3, "primary-model")
    yield* h.api.ChangeCast({
      chatId: h.chat.id,
      slotId: h.rows[4]!.slotId,
      change: { _tag: "SummaryModel", model: null }
    })
    yield* run(4, 5, "fallback-model")
  }).pipe(Effect.scoped)
)
