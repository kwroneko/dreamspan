// The one assembly path over a realistic synthetic ST folder (DESIGN §1.3, §5.0): imported by
// path, then the next context of a one-card chat and of a three-card group chat, under the
// folder's 128K preset, its global lorebook and a card with jailbreak-style prompts.
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { Generator } from "../src/chat/Generator.ts"
import { Reader } from "../src/db/Database.ts"
import { serverLayer, testConfig } from "./support/config.ts"
import { writeRealisticStFolder } from "./support/stRealistic.ts"
import { importStFolder } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"

describe("assembly over a realistic ST folder", () => {
  it.live(
    "attaches ST's global book to ST's selected preset, and fills one-card and group chats with the card prompts the preset allows",
    () =>
      Effect.gen(function* () {
        const root = tempDir("st-realistic-assembly")
        writeRealisticStFolder(root)
        const files = new Map(
          readdirSync(root, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => {
              const path = join(entry.parentPath, entry.name)
              return [relative(root, path), new Uint8Array(readFileSync(path))] as const
            })
        )
        // A second global book the folder doesn't hold.
        const settingsPath = [...files.keys()].find((path) => path.endsWith("settings.json"))!
        const settings = JSON.parse(new TextDecoder().decode(files.get(settingsPath)))
        settings.world_info_settings.world_info.globalSelect.push("Lost Atlas")
        files.set(settingsPath, new TextEncoder().encode(JSON.stringify(settings)))
        const { report, api } = yield* importStFolder(files)
        // Imported prompt presets do not supply model limits. This fixture tests a
        // 128K conversation, so configure that model explicitly and preserve its preset.
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Synthetic 128K",
            baseUrl: "http://127.0.0.1:1/v1",
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        const model = yield* api.AddUserModel({
          connectionId: connection.id,
          key: "synthetic-128k",
          overrides: { context: 128000, settings: { samplers: { openai_max_tokens: 300 } } }
        })
        yield* api.ChangeGenerationDefaults({ change: { model: { connection: connection.id, model: model.id } } })
        const reader = yield* Reader
        const me = yield* api.Whoami()
        const userId = me.id as UserId
        // ST's globalSelect: the book goes with the preset ST had selected, which the report
        // says, and names the book that wasn't in the folder (DESIGN §1.4).
        const books = yield* api.ListLibrary({ kind: "lorebook" })
        const almanac = books.find((b) => b.label === "Harbor Almanac")!
        assert.deepStrictEqual(
          (yield* api.LorebookPresets({ ref: almanac.id })).map((p) => [p.label, p.enabled]),
          [["Celia 4.2", true]]
        )
        assert.deepStrictEqual(
          report.issues.filter((i) => i.path === "settings.json").map((i) => [i.level, i.code, i.message]),
          [
            [
              "info",
              "st.global_worlds_attached",
              "Attached ST's global World Info book “Harbor Almanac” to the preset “Celia 4.2”."
            ],
            [
              "warning",
              "st.global_world_missing",
              "ST applies the lorebook “Lost Atlas” to every chat, but it wasn't in the folder, so it isn't used here."
            ]
          ]
        )
        const usage = yield* api.ListCardUsage()
        const aria = usage.find((c) => c.name === "Aria Vance")!
        const chats = yield* api.ListChats({ limit: 50, before: null, entityId: aria.entityId })
        const single = chats.find((c) => c.title.startsWith("Aria Vance"))!
        const next = yield* reader.CacheWarmth({ userId, chatId: single.id })
        const context = next.presetContext!
        assert.strictEqual(next.preset?.name, "Celia 4.2")
        // The 128K preset allows card overrides (an ST file's value): Aria's prompts are used.
        assert.deepStrictEqual(
          context.overrides?.map((o) => [o.identifier, o.name, o.status]),
          [
            ["main", "Aria Vance", "replaced"],
            ["jailbreak", "Aria Vance", "replaced"]
          ]
        )
        assert.deepStrictEqual(context.blocks.find((b) => b.identifier === "charDescription")?.labels, ["Aria Vance"])
        assert.isTrue(
          yield* reader.GetCardPromptUse({ userId }).pipe(Effect.map((u) => u.main.state === "replaceable"))
        )
        // Station Kepler: three characters, each in the joined definitions.
        const groups = yield* api.ListChatGroups()
        const kepler = groups.find((g) => g.name === "Station Kepler")!
        const group = yield* reader.CacheWarmth({ userId, chatId: kepler.latestChatId })
        assert.sameMembers(
          [...group.presetContext!.blocks.find((b) => b.identifier === "charDescription")!.labels],
          ["Captain Osei", "Dr. Ilsa Brandt", "Unit 7"]
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none))),
    180_000
  )
})
