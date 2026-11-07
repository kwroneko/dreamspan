// ST's public personas.js stores power_user.default_persona as the avatar filename.
// All content here, including the dev seed generator, is synthetic.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { png } from "./formats/support.ts"
import { encode } from "./support/stFolder.ts"
import { writeRealisticStFolder } from "./support/stRealistic.ts"
import { importStFolder } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"

const folder = (defaultPersona: string | null) =>
  new Map<string, Uint8Array>([
    [
      "settings.json",
      encode({
        power_user: {
          personas: { "a.png": "Default Ada", "b.png": "Other Bo" },
          default_persona: defaultPersona
        }
      })
    ],
    ["User Avatars/a.png", png()],
    ["User Avatars/b.png", png()]
  ])

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "180 seconds" })("ST account persona", (it) => {
  it.effect("adopts the named account persona, preserving other defaults and later account choices", () =>
    Effect.gen(function* () {
      const { api, report } = yield* importStFolder(folder("b.png"))
      assert.strictEqual(report.counts.persona?.added, 2)
      const cards = yield* api.ListLibrary({ kind: "card" })
      const ada = cards.find((c) => c.label === "Default Ada")!.entityId
      const bo = cards.find((c) => c.label === "Other Bo")!.entityId
      assert.strictEqual((yield* api.GetGenerationDefaults()).persona, bo)

      yield* api.ChangeGenerationDefaults({ change: { persona: ada, tail: "Keep my direction." } })
      const before = yield* api.GetGenerationDefaults()
      yield* importStFolder(folder("b.png"))
      assert.deepStrictEqual(yield* api.GetGenerationDefaults(), before)
      yield* importStFolder(folder("missing.png"))
      assert.deepStrictEqual(yield* api.GetGenerationDefaults(), before)

      yield* api.ChangeGenerationDefaults({ change: { persona: null } })
      yield* importStFolder(folder(null))
      assert.isNull((yield* api.GetGenerationDefaults()).persona)
      yield* importStFolder(folder("missing.png"))
      assert.isNull((yield* api.GetGenerationDefaults()).persona)
      // Unchanged personas are still resolved when importing again into an unset account.
      yield* importStFolder(folder("b.png"))
      assert.strictEqual((yield* api.GetGenerationDefaults()).persona, bo)
      assert.strictEqual((yield* api.GetGenerationDefaults()).lcm?.tail, "Keep my direction.")
    })
  )

  it.effect("the real dev seed's settings and avatars give a fresh account its default persona", () =>
    Effect.gen(function* () {
      const api = yield* client()
      yield* api.ChangeGenerationDefaults({ change: { persona: null } })
      // scripts/devinstance/sync.sh runs dev:seed, which imports this generator's folder.
      const root = writeRealisticStFolder(tempDir("dev-default-persona"))
      const files = new Map<string, Uint8Array>([
        ["settings.json", readFileSync(join(root, "settings.json"))],
        ["User Avatars/sam.png", readFileSync(join(root, "User Avatars/sam.png"))]
      ])
      yield* importStFolder(files)
      const sam = (yield* api.ListLibrary({ kind: "card" })).find((c) => c.label === "Sam")!
      assert.strictEqual((yield* api.GetGenerationDefaults()).persona, sam.entityId)
    })
  )
})
