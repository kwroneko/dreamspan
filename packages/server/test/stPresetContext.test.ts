// Synthetic folder imports exercised through HTTP and the next-context reader.
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { card, encode, header, jsonl, message } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"

const folder = (descriptionChars = 20_000) =>
  new Map([
    ["settings.json", encode({ oai_settings: { preset_settings_openai: "Roomy" } })],
    ["characters/Mira.png", card("Mira", "Hello.", {}, { description: "x".repeat(descriptionChars) })],
    [
      "OpenAI Settings/Roomy.json",
      encode({
        openai_max_context: 32000,
        openai_max_tokens: 300,
        temperature: 0.17,
        chat_completion_source: "custom",
        custom_url: "http://localhost:9999/v1",
        custom_model: "ignored-folder-model"
      })
    ],
    [
      "chats/Mira/Imported.jsonl",
      jsonl([
        header({}),
        ...Array.from({ length: 50 }, (_, i) =>
          message({
            name: i % 2 ? "Sam" : "Mira",
            user: i % 2 === 1,
            minute: i,
            mes: `Turn ${i}: ${"a".repeat(100)}`
          })
        )
      ])
    ]
  ])

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "90 seconds" })("ST selected preset", (it) => {
  for (const chars of [14_000, 20_000]) {
    it.effect(`uses explicit model settings for all 50 imported messages with a ${chars / 4}-token card`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        // The first import has no setting row; the second has an explicitly unset default.
        if (chars === 20_000) yield* api.SetGenerationDefaults({ defaults: { model: null, preset: null } })
        const { report } = yield* importStFolder(folder(chars))
        const chat = (yield* api.ListChats({ limit: 10, before: null }))[0]!
        const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
        assert.lengthOf(path.entries, 50)
        assert.lengthOf(yield* api.ListConnections(), chars === 14000 ? 0 : 1)
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Synthetic local",
            baseUrl: "http://localhost:1234/v1",
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        const model = yield* api.AddUserModel({
          connectionId: connection.id,
          key: `synthetic-${chars}`,
          overrides: { context: 32000, maxOutput: 300 }
        })
        yield* api.ChangeGenerationDefaults({ change: { model: { connection: connection.id, model: model.id } } })
        const next = yield* api.GetNextContext({ chatId: chat.id, leafSlotId: null })
        assert.strictEqual(next.historyStart?.depth, 0)
        assert.strictEqual(next.historyStart?.slotId, path.entries[0]!.slotId)
        assert.deepInclude(next.budget, {
          maximum: 32000,
          target: 25600,
          responseReserve: 300,
          presetName: "Roomy",
          builtinPreset: false
        })
        assert.deepInclude(next.preset, { name: "Roomy", scope: "user" })
        assert.isAbove(next.budget!.nonHistoryTokens, chars / 4)
        assert.isBelow(next.budget!.nonHistoryTokens, chars / 4 + 200)
        const defaults = yield* api.GetGenerationDefaults()
        assert.isNotNull(defaults.preset)
        // Nothing to act on: the report doesn't list it.
        assert.isUndefined(report.issues.find((i) => i.code === "st.preset_default"))
      })
    )
  }
  it.effect("returns a newest-message refusal before Send and clears it when the model budget is repaired", () =>
    Effect.gen(function* () {
      const api = yield* client()
      yield* importStFolder(folder(14_000))
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Newest-turn budget",
          baseUrl: "http://localhost:1234/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "small-context",
        overrides: { settings: { samplers: { openai_max_context: 4095, openai_max_tokens: 300 } } }
      })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      const chat = (yield* api.ListChats({ limit: 10, before: null }))[0]!
      const refused = yield* api.GetNextContext({ chatId: chat.id, leafSlotId: null })
      assert.isNull(refused.historyStart)
      assert.match(refused.assemblyError ?? "", /newest message/)
      // Fixed prompts fit the maximum: the refusal must still reach the UI.
      assert.isBelow(refused.budget!.nonHistoryTokens + refused.budget!.responseReserve, refused.budget!.maximum)
      yield* api.EditModel({
        modelId: model.id,
        expectedRowVersion: model.rowVersion,
        overrides: { settings: { samplers: { openai_max_context: 32000, openai_max_tokens: 300 } } }
      })
      const repaired = yield* api.GetNextContext({ chatId: chat.id, leafSlotId: null })
      assert.isNull(repaired.assemblyError)
      assert.strictEqual(repaired.historyStart?.depth, 0)
    })
  )
  it.effect("preserves a chosen default and names the preset ST used in the report", () =>
    Effect.gen(function* () {
      const api = yield* client()
      yield* importStFolder(folder())
      const chosen = (yield* api.ListLibrary({ kind: "preset" })).find((ref) => ref.label === "Roomy")!.id
      yield* api.SetGenerationDefaults({ defaults: { model: null, preset: chosen } })
      const files = folder()
      files.set("settings.json", encode({ oai_settings: { preset_settings_openai: "Other" } }))
      files.set("OpenAI Settings/Other.json", encode({ openai_max_context: 64000 }))
      const { report } = yield* importStFolder(files)
      assert.strictEqual((yield* api.GetGenerationDefaults()).preset, chosen)
      assert.deepInclude(
        report.issues.find((i) => i.code === "st.preset_kept"),
        {
          path: "settings.json",
          level: "warning",
          code: "st.preset_kept",
          message: "ST used preset “Other”; your existing default preset was kept."
        }
      )
      // Re-importing the selected preset still cannot replace the user's choice.
      assert.strictEqual(
        (yield* importStFolder(files)).report.issues.filter((i) => i.code === "st.preset_default").length,
        0
      )
      assert.strictEqual((yield* api.GetGenerationDefaults()).preset, chosen)
    })
  )
  it.effect("reports a selected file absent from the folder, including the built-in budget on failure", () =>
    Effect.gen(function* () {
      const api = yield* client()
      yield* api.SetGenerationDefaults({ defaults: { model: null, preset: null } })
      const files = folder()
      files.set("settings.json", encode({ oai_settings: { preset_settings_openai: "Missing" } }))
      const { report } = yield* importStFolder(files)
      assert.isNull((yield* api.GetGenerationDefaults()).preset)
      assert.deepInclude(
        report.issues.find((i) => i.code === "st.preset_missing"),
        {
          path: "settings.json",
          level: "warning",
          code: "st.preset_missing",
          message:
            "ST used preset “Missing”, but its preset file has not been imported from this folder. Your default preset was left unchanged."
        }
      )
      const chat = (yield* api.ListChats({ limit: 10, before: null }))[0]!
      const next = yield* api.GetNextContext({ chatId: chat.id, leafSlotId: null })
      assert.isNull(next.historyStart)
      assert.deepInclude(next.budget, {
        maximum: 8192,
        target: 6553,
        responseReserve: 4096,
        presetName: "Default (built-in)",
        builtinPreset: true
      })
      assert.deepStrictEqual(next.preset, { ref: null, name: "Default (built-in)", scope: "builtin" })
      assert.isAbove(next.budget!.nonHistoryTokens, 5000)
      const chosen = (yield* api.ListLibrary({ kind: "preset" })).find((ref) => ref.label === "Roomy")!.id
      yield* api.SetGenerationDefaults({ defaults: { model: null, preset: chosen } })
      assert.isTrue((yield* importStFolder(files)).report.issues.some((i) => i.code === "st.preset_missing"))
      assert.strictEqual((yield* api.GetGenerationDefaults()).preset, chosen)
    })
  )
})
