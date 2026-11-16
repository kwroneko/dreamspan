// ST's global regex scripts (extension_settings.regex, public/scripts/extensions/regex) come in
// with a full-folder import, into an empty global list only. All content here is synthetic.
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { serverLayer, testConfig } from "./support/config.ts"
import { encode } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"

const script = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  scriptName: name,
  findRegex: "/\\bteh\\b/gi",
  replaceString: "the",
  trimStrings: [],
  placement: [1, 2],
  disabled: false,
  markdownOnly: false,
  promptOnly: false,
  runOnEdit: true,
  substituteRegex: 0,
  minDepth: null,
  maxDepth: null,
  ...extra
})

const folder = (scripts: unknown) =>
  new Map<string, Uint8Array>([["settings.json", encode({ extension_settings: { regex: scripts } })]])

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "180 seconds" })("ST global regex", (it) => {
  it.effect("imports ST's global scripts into an empty list, and never replaces the account's", () =>
    Effect.gen(function* () {
      const { api, report } = yield* importStFolder(
        folder([
          script("g-1", "Fix typos"),
          script("g-2", "Hide OOC", { disabled: true, markdownOnly: true, placement: [2], keepMe: 7 })
        ])
      )
      assert.strictEqual(report.counts.regex?.added, 2)
      const stored = yield* api.GetGlobalRegex()
      assert.deepStrictEqual(
        stored.scripts.map((s) => [s.id, s.name, s.disabled, s.markdown_only, [...s.placement]]),
        [
          ["g-1", "Fix typos", false, false, [1, 2]],
          ["g-2", "Hide OOC", true, true, [2]]
        ]
      )
      assert.deepStrictEqual(stored.scripts[1]!.unsupported, { keepMe: 7 })

      // Imported again with other scripts: the list the account has stays as it is.
      const again = yield* importStFolder(folder([script("g-3", "Other")]))
      assert.strictEqual(again.report.counts.regex?.added ?? 0, 0)
      assert.strictEqual(again.report.counts.regex?.skipped, 1)
      assert.deepStrictEqual(
        (yield* api.GetGlobalRegex()).scripts.map((s) => s.id),
        ["g-1", "g-2"]
      )

      // A folder without global scripts changes nothing, and an emptied list takes them again.
      yield* importStFolder(new Map([["settings.json", encode({ extension_settings: {} })]]))
      assert.strictEqual((yield* api.GetGlobalRegex()).scripts.length, 2)
      const { revision } = yield* api.GetGlobalRegex()
      yield* api.SetGlobalRegex({ scripts: [], expectedRevision: revision })
      yield* importStFolder(folder([script("g-3", "Other"), "not a script"]))
      assert.deepStrictEqual(
        (yield* api.GetGlobalRegex()).scripts.map((s) => s.id),
        ["g-3"]
      )
    })
  )

  it.effect("keeps at most the global list's limit", () =>
    Effect.gen(function* () {
      const { api } = yield* importStFolder(folder([]))
      const { revision } = yield* api.GetGlobalRegex()
      yield* api.SetGlobalRegex({ scripts: [], expectedRevision: revision })
      const many = Array.from({ length: 105 }, (_, i) => script(`m-${i}`, `Script ${i}`))
      const { report } = yield* importStFolder(folder(many))
      assert.strictEqual(report.counts.regex?.added, 100)
      assert.strictEqual((yield* api.GetGlobalRegex()).scripts.length, 100)
    })
  )
})
