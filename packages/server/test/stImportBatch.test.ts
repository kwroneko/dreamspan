// Compare every stored message field and the derived indexes against the positional
// import path, which still writes each version and slot separately.
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import type { SlotId } from "@rp/shared/chat.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { Formats } from "../src/importer/Formats.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { card, largeChat } from "./support/stFolder.ts"
import { sendStFile } from "./support/stUpload.ts"

const config = testConfig()
const at = Date.UTC(2025, 0, 1)

layer(serverLayer(config), { excludeTestServices: true })("batched ST message inserts", (it) => {
  it.effect("store the same database rows as the positional path, including multiple batches and swipes", () =>
    Effect.gen(function* () {
      const clockStart = Date.now()
      const api = yield* client()
      const userId = (yield* api.Whoami()).id
      const { importId } = yield* api.StartStImport({ unsupported: [] })
      yield* sendStFile(importId, "characters/Alice.png", card("Alice", "Hello."))
      const sources = yield* (yield* Reader).StImportSources({ userId })
      const alice = sources.library[0]!.entityId
      const formats = yield* Formats
      const parsed = yield* formats.st.chatPart({
        bytes: new TextEncoder().encode(
          new TextDecoder()
            .decode(largeChat(205))
            .split("\n")
            .map((line, index) => {
              const message = JSON.parse(line)
              if (index === 1) {
                message.is_system = true
                message.swipe_id = 2
                message.mes = message.swipes[2]
                message.extra = {
                  reasoning: "Synthetic reasoning.",
                  model: "test-model",
                  api: "openai",
                  token_count: 42
                }
              }
              return JSON.stringify(message)
            })
            .join("\n")
        ),
        first: true,
        firstIndex: 0,
        carryAt: null,
        fallbackAt: at
      })
      const speakers = Object.fromEntries(parsed.speakers.map((s) => [s.key, s.user ? null : alice]))
      const writer = yield* Writer
      const run = (matching: boolean) =>
        Effect.gen(function* () {
          const target = yield* writer.StImportStartChat({
            userId,
            source: "chats/Alice/parity.jsonl",
            title: "Parity",
            createdAt: at,
            chatId: null,
            lease: importId
          })
          let parent: SlotId | null = null
          for (const batch of parsed.batches) {
            const result: { slotIds: ReadonlyArray<SlotId>; added: number } = yield* writer.StImportMessages({
              ...target,
              userId,
              lease: importId,
              advanceLeaf: true,
              strict: false,
              parentSlotId: parent,
              matching,
              speakers,
              messagesJson: batch.messagesJson,
              arrivalRefs: Object.fromEntries(
                parsed.speakers.filter((s) => !s.user).map((s) => [s.key, sources.library[0]!.refId])
              )
            })
            assert.strictEqual(result.added, result.slotIds.length)
            parent = result.slotIds.at(-1) ?? parent
          }
          const chat = target.chatId
          const result = yield* fixtureSql(
            config.dataDir,
            [
              { sql: "SELECT * FROM chats WHERE id = ?", params: [chat] },
              { sql: "SELECT * FROM lanes WHERE chat_id = ? ORDER BY id", params: [chat] },
              { sql: "SELECT * FROM forks WHERE chat_id = ? ORDER BY id", params: [chat] },
              { sql: "SELECT * FROM slots WHERE chat_id = ? ORDER BY depth", params: [chat] },
              {
                sql: "SELECT v.* FROM slots s JOIN versions v ON v.slot_id = s.id WHERE s.chat_id = ? ORDER BY s.depth, v.ordinal",
                params: [chat]
              },
              {
                sql: "SELECT p.* FROM slots s JOIN versions v ON v.slot_id = s.id JOIN version_participants p ON p.version_id = v.id WHERE s.chat_id = ? ORDER BY s.depth, v.ordinal, p.entity_id",
                params: [chat]
              },
              { sql: "SELECT * FROM state_events WHERE chat_id = ? ORDER BY seq", params: [chat] },
              { sql: "SELECT * FROM jobs WHERE id = ?", params: [target.recordId] },
              {
                sql: "SELECT v.id, f.content FROM slots s JOIN versions v ON v.slot_id = s.id JOIN versions_fts f ON f.rowid = v.seq WHERE s.chat_id = ? ORDER BY s.depth, v.ordinal",
                params: [chat]
              },
              { sql: "PRAGMA foreign_key_check" }
            ],
            { readOnly: true }
          )
          assert.deepStrictEqual(result.at(-1), [])
          // IDs and bookkeeping clocks differ between the two independent chat imports.
          // Every other column, including stamps, lineage and chain assignments, is compared.
          const ids = new Map<string, string>([
            [target.recordId, "record"],
            [chat, "chat"]
          ])
          for (const [table, rows] of result.entries()) {
            for (const [index, row] of rows.entries()) {
              if (typeof row.id === "string" && table !== 8) ids.set(row.id, `${table}:${index}`)
            }
          }
          const normalize = (value: unknown): unknown => {
            if (typeof value === "number" && value >= clockStart) return "clock"
            if (typeof value === "string") {
              let text = value
              for (const [id, key] of ids) text = text.replaceAll(id, key)
              return text
            }
            if (Array.isArray(value)) return value.map(normalize)
            if (value !== null && typeof value === "object")
              return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, normalize(val)]))
            return value
          }
          result[4]!.forEach((row, index) => {
            row.seq = index
          })
          return normalize(result)
        })
      const positional = yield* run(true)
      const batched = yield* run(false)
      assert.deepStrictEqual(batched, positional)
    })
  )
})
