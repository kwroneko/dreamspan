// Linking imported ST chats to cards when the folder name doesn't (ARCHITECTURE.md §13):
// a card whose file was renamed, ST's "undefined" folder, and the lorebook a card names
// but ST never saved, as Chub's downloads leave them. Every file is made up.
import { DatabaseSync } from "node:sqlite"
import { assert, layer } from "@effect/vitest"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { foldState } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { card, header, jsonl, message } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"

const chat = (who: string, ...lines: ReadonlyArray<string>) =>
  jsonl([
    header({}),
    message({ name: who, mes: lines[0]!, minute: 0 }),
    message({ name: "Sam", user: true, mes: "Hello.", minute: 1 }),
    ...lines.slice(1).map((mes, i) => message({ name: who, mes, minute: i + 2 }))
  ])

const book = { name: "Nova's lore", entries: [{ keys: ["comet"], content: "Comets are Nova's.", id: 0 }] }

const folder = new Map<string, Uint8Array>([
  // Downloaded again: ST saved the card as a new file, and its old chats keep the old folder.
  // The chats' greeting was edited, so only the character's name links them.
  [
    "characters/main_nova-1a2b3c_spec_v2.png",
    card("Nova", "Nova looks up.", { world: "main_nova_sillytavern" }, { character_book: book })
  ],
  [
    "chats/main_nova-1a2b3c_spec_v2 (1)/Nova - 2024-1-15@05h32m35s459ms.jsonl",
    chat("Nova", "Nova waves from the roof.", "The comet.")
  ],
  [
    "chats/main_nova-1a2b3c_spec_v2/Nova - 2024-1-16@05h32m35s459ms.jsonl",
    chat("Nova", "Nova waves from the roof.", "Again.")
  ],
  // A card naming a lorebook it doesn't carry, which isn't in the folder either.
  ["characters/Vale.png", card("Vale", "Vale nods.", { world: "Vale lore" })],
  ["chats/Vale/Vale - one.jsonl", chat("Vale", "Vale nods.", "One.")],
  ["chats/Vale/Vale - two.jsonl", chat("Vale", "Vale nods.", "Two.")],
  // Saved with no character selected; nobody in it has a card.
  ["chats/undefined/ - 2023-9-10@03h03m01s556ms.jsonl", chat("Wisp", "A light drifts.", "Gone.")]
])

const config = testConfig()

const chatBySource = (source: string) => {
  const conn = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
  const row = conn
    .prepare(
      "SELECT json_extract(payload_json, '$.chatId') AS chatId FROM jobs WHERE json_extract(payload_json, '$.source') = ?"
    )
    .get(source)
  conn.close()
  return row?.chatId as ChatId
}

const stateOf = (chatId: ChatId) =>
  Effect.gen(function* () {
    const reader = yield* Reader
    const user = yield* (yield* client()).Whoami()
    return foldState(yield* reader.StateEventsAt({ userId: user.id, chatId, slotId: null }))
  })

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })(
  "ST chats linked by more than folder",
  (it) => {
    it.effect("links a renamed card's chats by the character's name, and explains what can't be linked", () =>
      Effect.gen(function* () {
        const { answers, report } = yield* importStFolder(folder)
        assert.strictEqual(
          answers.get("chats/main_nova-1a2b3c_spec_v2 (1)/Nova - 2024-1-15@05h32m35s459ms.jsonl")?.outcome,
          "added"
        )
        assert.strictEqual(
          answers.get("chats/main_nova-1a2b3c_spec_v2/Nova - 2024-1-16@05h32m35s459ms.jsonl")?.outcome,
          "added"
        )
        const [undefinedChat, ...others] = report.links
        assert.lengthOf(others, 0)
        assert.strictEqual(undefinedChat!.path, "chats/undefined/ - 2023-9-10@03h03m01s556ms.jsonl")
        assert.include(undefinedChat!.reason, "without a character")
        assert.include(undefinedChat!.reason, "“Wisp”")

        // ST never imported Nova's own lorebook, so it didn't send it: her chats have it off.
        const nova = yield* stateOf(
          chatBySource("chats/main_nova-1a2b3c_spec_v2/Nova - 2024-1-16@05h32m35s459ms.jsonl")
        )
        assert.deepStrictEqual(Object.values(nova.embeddedLorebooks), [false])
        const vale = yield* stateOf(chatBySource("chats/Vale/Vale - one.jsonl"))
        assert.deepStrictEqual(vale.embeddedLorebooks, {})

        // Nova's lorebook is inside her card, so it isn't reported missing; Vale's is, once.
        const missing = report.issues.filter((issue) => issue.code === "st.world_missing")
        assert.lengthOf(missing, 1)
        assert.include(missing[0]!.message, "Vale lore")
      })
    )
  }
)
