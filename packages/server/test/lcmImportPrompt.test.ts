import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { lcmHarness, lcmTest, lastText, requestsTo } from "./support/lcmHarness.ts"
import { backfillFolder } from "./support/stBackfill.ts"
import { encode } from "./support/stFolder.ts"
import { importStFolder, sendStFile } from "./support/stUpload.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

lcmTest("HTTP folder imports keep ST's instruction as an editable default used at the provider", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 0 })
    const prompt = "Record promises and names in {{words}} words. Keep {{char}} literally."
    const memory = { prompt, promptWords: 175, position: 1, depth: 3, role: 0, template: "[Story: {{summary}}]" }
    const files = new Map(backfillFolder("ST/data/synthetic/", ["Bob - instruction"], { hidden: 0, visible: 8 }))
    files.set("ST/data/synthetic/settings.json", encode({ extension_settings: { memory } }))
    const imported = yield* importStFolder(files)
    const defaults = yield* h.api.GetGenerationDefaults()
    assert.strictEqual(defaults.lcm?.tail, prompt)
    assert.deepStrictEqual(defaults.model, h.primary)
    const [stored] = yield* fixtureSql(h.dataDir, [
      { sql: "SELECT value_json FROM user_settings WHERE user_id=? AND key='import.st.memory'", params: [h.userId] }
    ])
    assert.deepInclude(JSON.parse(stored![0]!.value_json as string), memory)
    const chats = yield* h.api.ListChats({ limit: 50, before: null })
    const chatId = chats.find((c) => c.title === "Bob - instruction")!.id
    yield* h.api.SetLcmEnabled({ chatId, enabled: true })
    const path = yield* h.reader.GetPath({ userId: h.userId, chatId, leafSlotId: null, limit: 100 })
    let chunk = 0
    const run = () =>
      Effect.gen(function* () {
        yield* h.writer.EnqueueSummaries({
          userId: h.userId,
          chatId,
          leafSlotId: path.entries.at(-1)!.slotId,
          chunks: [
            {
              target: 75,
              inputs: path.entries
                .slice(chunk * 2, ++chunk * 2)
                .map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: 0 }))
            }
          ],
          requestClass: "interactive"
        })
        yield* h.runNext
      })
    yield* run()
    assert.strictEqual(
      lastText(requestsTo(h.mock, "primary-model").at(-1)!),
      // A length of 75 tokens asks for 56 words (DESIGN §8).
      prompt.replace("{{words}}", "56") + "\nReturn only the summary, without commentary."
    )
    yield* h.api.SetGenerationDefaults({
      defaults: { ...defaults, lcm: { ...defaults.lcm, tail: "My new instruction." } }
    })
    yield* sendStFile(imported.importId, "settings.json", encode({ extension_settings: { memory } }))
    assert.strictEqual((yield* h.api.GetGenerationDefaults()).lcm?.tail, "My new instruction.")
    yield* h.writer.AddStateEvent({
      userId: h.userId,
      chatId,
      slotId: null,
      versionId: null,
      scope: null,
      data: { key: "lcm.settings", value: { enabled: true, tail: "This chat's instruction." } }
    })
    yield* run()
    assert.include(lastText(requestsTo(h.mock, "primary-model").at(-1)!), "This chat's instruction.")
    yield* sendStFile(imported.importId, "settings.json", encode({ extension_settings: { memory: {} } }))
    assert.strictEqual((yield* h.api.GetGenerationDefaults()).lcm?.tail, "My new instruction.")
  })
)
