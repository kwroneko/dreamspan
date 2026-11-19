import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { autoConfigurationStamp, configurationRevision, trackAutoConfiguration } from "../src/chat/autoConfiguration.ts"
import { makeRegistry } from "@dreamspan/shared/registry.ts"

it.effect("unversioned mutable request registries cannot authorize automatic dispatch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const unknown = { register: () => Effect.void }
      yield* trackAutoConfiguration(() => [configurationRevision(unknown)])
      assert.notStrictEqual(autoConfigurationStamp(), autoConfigurationStamp())
    })
  )
)

it.effect("unrelated local registries do not change a watched request configuration", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const watched = makeRegistry([{ id: "sent" }])
      yield* trackAutoConfiguration(() => [configurationRevision(watched)])
      const before = autoConfigurationStamp()
      yield* makeRegistry().register({ id: "local" })
      assert.strictEqual(autoConfigurationStamp(), before)
      yield* watched.disable("sent")
      assert.notStrictEqual(autoConfigurationStamp(), before)
    })
  )
)
