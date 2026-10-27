// The one assembly path over a realistic synthetic ST folder (DESIGN §1.3, §5.0): imported by
// path, then the next context of a one-card chat and of a three-card group chat, under the
// folder's 128K preset, its global lorebook and a card with jailbreak-style prompts.
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@rp/shared/domain.ts"
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
    "marks ST's global book global, and fills one-card and group chats with the card prompts the preset allows",
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
        const { report, api } = yield* importStFolder(files)
        const reader = yield* Reader
        const me = yield* api.Whoami()
        const userId = me.id as UserId
        // ST's globalSelect: the book is the user's global, and the report says so.
        const books = yield* api.ListLibrary({ kind: "lorebook" })
        const almanac = books.find((b) => b.label === "Harbor Almanac")!
        assert.deepStrictEqual([...(yield* api.GetGlobalLorebooks())], [almanac.id])
        assert.isTrue(
          JSON.stringify(report).includes("marked “Use in every chat”"),
          "the report names the global books as marked"
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
