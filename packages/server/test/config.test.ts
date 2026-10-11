import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer } from "effect"
import { AppConfig } from "../src/config.ts"

const load = (env: Record<string, string>) =>
  Effect.exit(Layer.build(AppConfig.layer)).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
    Effect.scoped
  )

describe("configuration", () => {
  it.effect("refuses fewer than one database reader", () =>
    Effect.gen(function* () {
      for (const readers of ["0", "-1"]) {
        assert.isTrue(Exit.isFailure(yield* load({ DB_READERS: readers })), `DB_READERS=${readers}`)
      }
      assert.isTrue(Exit.isSuccess(yield* load({ DB_READERS: "1" })))
      assert.isTrue(Exit.isSuccess(yield* load({})))
    })
  )
})
