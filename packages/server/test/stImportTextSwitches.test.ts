import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { encode } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"

layer(serverLayer(testConfig()))("ST global text switches", (it) => {
  it.effect("copies global switches to prompt presets and reimports settings-only changes", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const folder = (on: boolean) =>
        new Map([
          [
            "data/default-user/settings.json",
            encode({ power_user: { pin_examples: on, strip_examples: on, collapse_newlines: on } })
          ],
          ["data/default-user/OpenAI Settings/Switches.json", encode({ frequency_penalty: 0 })]
        ])
      yield* importStFolder(folder(true))
      const ref = (yield* api.ListLibrary({ kind: "preset" })).find((p) => p.label === "Switches")!
      const first = yield* api.OpenEditor({ refId: ref.id })
      for (const key of ["pin_examples", "strip_examples", "collapse_newlines"])
        assert.strictEqual(first.doc[key], true)
      assert.isUndefined(first.doc.samplers)
      yield* importStFolder(folder(false))
      const next = yield* api.OpenEditor({ refId: ref.id })
      for (const key of ["pin_examples", "strip_examples", "collapse_newlines"])
        assert.strictEqual(next.doc[key], false)
      assert.notStrictEqual(next.ref.headRevisionId, first.ref.headRevisionId)
    })
  )

  it.effect("copies ST's reasoning formatting to the imported presets", () =>
    Effect.gen(function* () {
      const api = yield* client()
      yield* importStFolder(
        new Map([
          [
            "data/default-user/settings.json",
            encode({
              power_user: {
                reasoning: {
                  auto_parse: true,
                  add_to_prompts: true,
                  max_additions: 2,
                  prefix: "<think>",
                  suffix: "</think>"
                }
              }
            })
          ],
          ["data/default-user/OpenAI Settings/Reasoned.json", encode({ frequency_penalty: 0 })]
        ])
      )
      const ref = (yield* api.ListLibrary({ kind: "preset" })).find((p) => p.label === "Reasoned")!
      const opened = yield* api.OpenEditor({ refId: ref.id })
      assert.deepStrictEqual(opened.doc.reply_sections, {
        enabled: true,
        pairs: [{ open: "<think>", close: "</think>", case_sensitive: true }],
        send_back: 2
      })
      assert.isUndefined(opened.doc.pin_examples)
    })
  )
})
