// Combined branches: foreign separate-history merges and their Undo must fence Auto.
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { posted } from "./support/config.ts"
import { eventually, finished } from "./support/generation.ts"
import { runMergeStory } from "./support/mergeOrigin.ts"

it.live(
  "a separate-history merge and its Undo each end the destination's Auto run",
  () =>
    runMergeStory((t) =>
      Effect.gen(function* () {
        const source = yield* t.chat("Pier", [t.wren])
        yield* t.say(source, t.wren, "PIERSEAM456")
        const ask = (token: string | null) =>
          Effect.flatMap(t.tip(t.ledger), (parentSlotId) =>
            t.api.Generate({
              ...t.ledger,
              parentSlotId,
              branch: false,
              immediate: true,
              speakerEntityId: t.mira,
              auto: { token }
            })
          )
        const turn = (token: string | null) =>
          Effect.gen(function* () {
            const result = yield* posted(ask(token))
            yield* eventually(() => finished(t.events, result.entry.version.id) !== undefined)
            assert.strictEqual(finished(t.events, result.entry.version.id)!.status, "complete")
            return result.auto!.token
          })
        const token = yield* turn(null)
        const join = yield* t.merge(t.ledger, source, "separate")
        const count = t.mock.requests().length
        assert.strictEqual((yield* Effect.flip(ask(token)))._tag, "AutoRefused")
        assert.strictEqual(t.mock.requests().length, count)
        const next = yield* turn(null)
        assert.include(t.mock.requests().at(-1)!.raw!, "The road flooded.")
        yield* t.api.DeleteMessage({ slotId: join.slotId, forkId: t.ledger.forkId })
        const after = t.mock.requests().length
        assert.strictEqual((yield* Effect.flip(ask(next)))._tag, "AutoRefused")
        assert.strictEqual(t.mock.requests().length, after)
      })
    ),
  120_000
)
