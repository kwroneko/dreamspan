import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { runMergeStory } from "./support/mergeOrigin.ts"
import { eventually, finished } from "./support/generation.ts"
import { posted } from "./support/config.ts"

// Capture real local HTTP bodies, after all assembly/provider transforms. No external provider.
it.live(
  "replies, continues and regenerations keep separate origins and their causal horizon on the wire",
  () =>
    runMergeStory((t) =>
      Effect.gen(function* () {
        yield* t.api.EditModel({
          modelId: t.model.id,
          expectedRowVersion: t.model.rowVersion,
          overrides: { prefill: "assistant" }
        })
        const kai = yield* t.card("Kai")
        const source = yield* t.chat("Docks", [kai])
        yield* t.say(source, kai, "DOCKSWIRE")
        yield* t.say(t.ledger, t.mira, "HOMEWIRE")
        const beforeJoin = yield* t.say(t.ledger, t.mira, "TARGETWIRE")
        yield* t.merge(t.ledger, source, "separate")
        const afterJoin = yield* t.say(t.ledger, t.mira, "AFTERWIRE")
        const lastBody = () =>
          JSON.stringify(
            t.mock
              .requests()
              .filter((r) => r.path === "/v1/chat/completions")
              .at(-1)!.body
          )
        for (const [speaker, known, unknown] of [
          [t.mira, "HOMEWIRE", "DOCKSWIRE"],
          [kai, "DOCKSWIRE", "HOMEWIRE"]
        ] as const) {
          const generated = yield* posted(
            t.api.Generate({
              chatId: t.ledger.chatId,
              forkId: t.ledger.forkId,
              parentSlotId: afterJoin,
              branch: true,
              speakerEntityId: speaker
            })
          )
          yield* eventually(() => finished(t.events, generated.entry.version.id) !== undefined, 60_000)
          assert.strictEqual(finished(t.events, generated.entry.version.id)!.status, "complete")
          const forkId = generated.chat.currentForkId!
          const verify = () => {
            const body = lastBody()
            assert.include(body, known)
            assert.notInclude(body, unknown)
            assert.include(body, "AFTERWIRE")
          }
          verify()
          const at = yield* t.reader.GetSlot({ userId: t.userId, slotId: generated.entry.slotId, forkId })
          const continued = yield* t.api.ContinueVersion({
            versionId: generated.entry.version.id,
            forkId,
            expectedRowVersion: at.entry.rowVersion
          })
          yield* eventually(() => finished(t.events, continued.version.id) !== undefined, 60_000)
          assert.strictEqual(finished(t.events, continued.version.id)!.status, "complete")
          verify()
          const fresh = yield* t.reader.GetSlot({ userId: t.userId, slotId: generated.entry.slotId, forkId })
          const regen = yield* t.api.Regenerate({
            slotId: generated.entry.slotId,
            forkId,
            expectedRowVersion: fresh.entry.rowVersion
          })
          yield* eventually(() => finished(t.events, regen.version.id) !== undefined, 60_000)
          assert.strictEqual(finished(t.events, regen.version.id)!.status, "complete")
          verify()
        }
        const old = yield* t.reader.GetSlot({ userId: t.userId, slotId: beforeJoin, forkId: t.ledger.forkId })
        const regen = yield* t.api.Regenerate({
          slotId: beforeJoin,
          forkId: t.ledger.forkId,
          expectedRowVersion: old.entry.rowVersion
        })
        yield* eventually(() => finished(t.events, regen.version.id) !== undefined, 60_000)
        assert.include(lastBody(), "HOMEWIRE")
        assert.notInclude(lastBody(), "DOCKSWIRE")
        assert.notInclude(lastBody(), "AFTERWIRE")
        const current = yield* t.reader.GetSlot({ userId: t.userId, slotId: beforeJoin, forkId: t.ledger.forkId })
        const continued = yield* t.api.ContinueVersion({
          versionId: regen.version.id,
          forkId: t.ledger.forkId,
          expectedRowVersion: current.entry.rowVersion
        })
        yield* eventually(() => finished(t.events, continued.version.id) !== undefined, 60_000)
        assert.include(lastBody(), "HOMEWIRE")
        assert.notInclude(lastBody(), "DOCKSWIRE")
        assert.notInclude(lastBody(), "AFTERWIRE")
      })
    ),
  { timeout: 180_000 }
)
