import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer } from "effect"
import { AppConfig } from "../src/config.ts"
import { tempDir } from "./support/tempDir.ts"

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

  it("refuses the fake generator in production, before anything starts", () => {
    const dataDir = tempDir("fake")
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
      env: { ...process.env, NODE_ENV: "production", FAKE_GENERATOR_TPS: "300", DATA_DIR: dataDir, PORT: "9" },
      encoding: "utf8",
      timeout: 20_000
    })
    assert.notStrictEqual(run.status, 0)
    assert.include(run.stdout + run.stderr, "FakeGeneratorInProduction")
    // It stopped before opening the database.
    assert.deepStrictEqual(readdirSync(dataDir), [])
  })
})
