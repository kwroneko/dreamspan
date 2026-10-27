import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { uuidv7 } from "@rp/shared/id.ts"
import type { ConnectionId } from "@rp/shared/providers.ts"
import { NewVersion } from "@rp/shared/chat.ts"
import { promptPreset } from "@rp/shared/docs/preset.ts"
import { DEFAULT_SAMPLERS } from "@rp/shared/modelSettings.ts"
import * as Database from "../src/db/Database.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { importPromptPreset, importStSettings, exportPromptPreset } from "../src/formats/presetSettings.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { providerRequest } from "../src/assembler/wire.ts"
import { tempDir } from "./support/tempDir.ts"

const file = JSON.stringify({
  temperature: 0.37,
  top_p: 0.83,
  openai_max_context: 24000,
  openai_max_tokens: 700,
  stream_openai: false,
  stop: ["END"],
  logit_bias: { "42": -2 },
  chat_completion_source: "custom",
  custom_url: "http://localhost:1234/v1",
  custom_model: "synthetic-model",
  proxy_password: "never-import-me",
  api_key: "never-import-me",
  main_prompt: "Tell a synthetic story.",
  assistant_prefill: "Once"
})

describe("separate ST preset import surfaces", () => {
  it("imports prompt text and reports ignored settings without keeping model or connection data", () => {
    const imported = importPromptPreset(file)
    assert.ok(imported.document)
    assert.notProperty(imported.document, "samplers")
    assert.notProperty(imported.document, "names_behavior")
    assert.strictEqual(imported.document.prefill.assistant, "Once")
    assert.ok(imported.report.issues.some((issue) => issue.code === "preset.model_settings_ignored"))
    assert.notInclude(JSON.stringify(imported.document), "never-import-me")
    const exported = exportPromptPreset(importStPreset(file).document!)
    assert.notProperty(exported, "temperature")
    assert.notProperty(exported, "custom_url")
  })
  it("imports only model settings with a report, including stop strings and streaming", () => {
    const imported = importStSettings(file, "model")
    assert.strictEqual(imported.model?.samplers?.temperature, 0.37)
    assert.strictEqual(imported.model?.samplers?.openai_max_context, 24000)
    assert.deepStrictEqual(imported.model?.stop, ["END"])
    assert.strictEqual(imported.model?.stream, false)
    assert.isNull(imported.connection)
    assert.notInclude(JSON.stringify(imported), "never-import-me")
  })
  it("imports API type, URL and model name without keys, and reports all ignored parts", () => {
    const imported = importStSettings(file, "connection")
    assert.deepStrictEqual(imported.connection, {
      kind: "openai-chat",
      baseUrl: "http://localhost:1234/v1",
      model: "synthetic-model"
    })
    assert.isNull(imported.model)
    assert.ok(imported.report.issues.some((issue) => issue.code === "settings.ignored"))
    assert.notInclude(JSON.stringify(imported), "never-import-me")
    assert.isNull(importStSettings('{"custom_url":"https://user:secret@example.test/v1"}', "connection").connection)
  })
  it("reports malformed files for both settings surfaces", () => {
    for (const surface of ["model", "connection"] as const) {
      const result = importStSettings("{broken", surface)
      assert.isNull(result[surface])
      assert.ok(result.report.issues.some((issue) => issue.level === "error"))
    }
  })
})

it.live(
  "assembly uses model settings globally, ignores old chat bindings, and applies a connection lock only on switching connections",
  () =>
    Effect.gen(function* () {
      const writer = yield* Database.Writer
      const reader = yield* Database.Reader
      const userId = (yield* writer.EnsureUser({ handle: "synthetic", displayName: "Synthetic" })).id
      const preset = (label: string, temperature: number) =>
        writer.CreateEntity({
          userId,
          kind: "preset",
          label,
          subtitle: "",
          doc: promptPreset(importStPreset(JSON.stringify({ temperature, main_prompt: label })).document!),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
      const first = yield* preset("First prompt", 0.1)
      const second = yield* preset("Second prompt", 1.9)
      const connection = (lock: typeof first.ref.id | null) => {
        const connectionId = uuidv7() as ConnectionId
        return writer.CreateConnection({
          userId,
          connectionId,
          kind: "openai-chat",
          api: "openai-completions",
          settings: {
            name: "Synthetic",
            baseUrl: null,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: lock
          },
          credential: { existing: null }
        })
      }
      const a = yield* connection(null)
      const b = yield* connection(second.ref.id)
      const modelA = yield* writer.AddUserModel({
        userId,
        connectionId: a.id,
        key: "a",
        overrides: {
          context: 16000,
          maxOutput: 600,
          settings: { samplers: { temperature: 0.23 }, stop: ["END"], logit_bias: { "42": -3 } }
        }
      })
      const modelB = yield* writer.AddUserModel({ userId, connectionId: b.id, key: "b", overrides: {} })
      const chat = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "Synthetic",
        participants: [],
        greeting: new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content: "Hello",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      })
      const next = yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        parentSlotId: chat.activeLeafSlotId,
        branch: false,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "model",
          content: "",
          status: "generating",
          macroMode: "verbatim",
          origin: "generated"
        })
      })
      const change = (selection: Parameters<typeof writer.ChangeGenerationDefaults>[0]["change"]) =>
        writer.ChangeGenerationDefaults({ userId, change: selection })
      const build = () =>
        reader
          .AssembleContext({
            userId,
            chatId: chat.id,
            slotId: next.slotId,
            versionId: next.version.id,
            now: 1,
            timeZone: "UTC",
            frozen: null
          })
          .pipe(Effect.map(({ snapshot }) => JSON.parse(snapshot) as ContextSnapshot))
      yield* change({ preset: first.ref.id, model: { connection: a.id, model: modelA.id } })
      for (const data of [
        { key: "model.binding", value: { connection: b.id, model: modelB.id } },
        { key: "preset.binding", value: { ref: second.ref.id } }
      ] as const)
        yield* writer.AddStateEvent({
          userId,
          chatId: chat.id,
          slotId: null,
          versionId: null,
          scope: null,
          data: data as never
        })
      const assembled = yield* build()
      assert.strictEqual(assembled.request.samplers.temperature, 0.23)
      assert.strictEqual(assembled.request.samplers.max_tokens, 600)
      assert.strictEqual(assembled.inputs.preset.ref, first.ref.id)
      const wire = providerRequest(assembled.request, assembled.inputs.model!)
      assert.deepStrictEqual(wire.payload.stop, ["END"])
      assert.deepStrictEqual(wire.payload.logit_bias, { "42": -3 })
      yield* change({ preset: second.ref.id })
      assert.strictEqual((yield* build()).request.samplers.temperature, 0.23)
      assert.strictEqual((yield* reader.GetGenerationDefaults({ userId })).model?.model, modelA.id)
      yield* change({ model: { connection: b.id, model: modelB.id } })
      assert.strictEqual((yield* reader.GetGenerationDefaults({ userId })).preset, second.ref.id)
      assert.strictEqual((yield* build()).request.samplers.temperature, DEFAULT_SAMPLERS.temperature)
      yield* change({ preset: first.ref.id })
      assert.strictEqual((yield* build()).inputs.preset.ref, first.ref.id)
      yield* change({ model: { connection: b.id, model: modelB.id } })
      assert.strictEqual((yield* reader.GetGenerationDefaults({ userId })).preset, first.ref.id)
      yield* change({ model: { connection: a.id, model: modelA.id } })
      assert.strictEqual((yield* reader.GetGenerationDefaults({ userId })).preset, first.ref.id)
    }).pipe(
      Effect.provide(
        Database.layer({
          dataDir: tempDir("global-model-settings"),
          readers: 1,
          allowNetworkFs: false,
          workers: "source"
        })
      )
    )
)
