import { docHash } from "../src/db/documents.ts"
// Compare every stored message field and the derived indexes against the positional
// import path, which still writes each version and slot separately.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assert, it, layer } from "@effect/vitest"
import { Effect } from "effect"
import type { SlotId } from "@rp/shared/chat.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { Formats } from "../src/importer/Formats.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { StParserRegistry } from "../src/importer/stParserRegistry.ts"
import { tempDir } from "./support/tempDir.ts"
import { card, largeChat, writeStBranchFamily } from "./support/stFolder.ts"
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

it.live(
  "stores identical branch families with 20–50 swipes through cached and positional matching",
  () => {
    const root = tempDir("st-family-parity")
    const family = writeStBranchFamily(root, { branches: 8, messages: 40, swipeShare: 1 })
    const clockStart = Date.now()
    const run = (cached: boolean, change: "clean" | "local" | "swipe" | "subset") => {
      const config = testConfig()
      return Effect.gen(function* () {
        if (!cached)
          yield* (yield* StParserRegistry).register({
            id: "chat-part",
            module: new URL("./support/stParserPlugin.ts", import.meta.url).href,
            exportName: "positionalChatPart"
          })
        const api = yield* client()
        const owner = (yield* api.Whoami()).id
        const { importId } = yield* api.StartStImport({ unsupported: [] })
        yield* sendStFile(importId, "characters/Alice.png", card("Alice", "Hello."))
        for (const file of family.files) {
          let bytes = new Uint8Array(readFileSync(join(root, file.path)))
          if ((change === "swipe" || change === "subset") && file === family.files[1]) {
            const lines = new TextDecoder().decode(bytes).split("\n")
            const first = JSON.parse(lines[1]!)
            if (change === "subset") {
              first.swipes = [first.mes]
              first.swipe_info = [first.swipe_info[first.swipe_id]]
              first.swipe_id = 0
            } else {
              first.swipes.push("A new synthetic swipe on the branch's shared first message.")
              first.swipe_info.push({ send_date: first.send_date, extra: {} })
            }
            lines[1] = JSON.stringify(first)
            bytes = new TextEncoder().encode(lines.join("\n"))
          }
          const result = yield* sendStFile(importId, file.path, bytes, {}, 256 * 1024)
          assert.include(["added", "updated"], result.outcome)
          if (change === "local" && file === family.files[0]) {
            const chat = (yield* api.ListChats({ limit: 10, before: null }))[0]!
            const entry = (yield* api.ReadPath({
              chatId: chat.id,
              leafSlotId: null,
              range: { _tag: "Bottom" },
              limit: 100
            })).entries[0]!
            yield* api.EditVersion({
              slotId: entry.slotId,
              sourceVersionId: entry.version.id,
              content: "A local edit made while the folder is still importing.",
              images: [],
              expectedRowVersion: entry.rowVersion
            })
          }
        }
        yield* api.FinishStImport({ importId, notSent: [] })
        const report = yield* api.GetStImportReport({ importId })
        const library = yield* api.GetShellLibrary()
        const tables = [
          "entities",
          "entity_refs",
          "entity_revisions",
          "chats",
          "lanes",
          "forks",
          "slots",
          "versions",
          "state_events",
          "fork_overrides"
        ]
        const rows = yield* fixtureSql(
          config.dataDir,
          [
            ...tables.map((table) => ({ sql: `SELECT * FROM ${table} ORDER BY id` })),
            { sql: "SELECT * FROM jobs WHERE kind = 'st-import-chat' ORDER BY id" },
            { sql: "SELECT * FROM version_participants ORDER BY version_id, entity_id" },
            { sql: "SELECT v.id, f.content FROM versions v JOIN versions_fts f ON f.rowid = v.seq ORDER BY v.id" },
            { sql: "SELECT * FROM media_assets ORDER BY id" },
            { sql: "PRAGMA foreign_key_check" }
          ],
          { readOnly: true }
        )
        assert.deepStrictEqual(rows.at(-1), [])
        assert.lengthOf(rows[6]!, family.uniqueMessages)
        assert.lengthOf(rows[7]!, family.uniqueVersions + (change === "local" || change === "swipe" ? 1 : 0))
        assert.lengthOf(rows[5]!, family.files.length)
        // All physical storage and derived search/participation rows, plus the shell's
        // summaries. Only independent IDs, sequence offsets and wall clocks differ.
        const ids = new Map<string, string>([
          [importId, "import"],
          [owner, "owner"]
        ])
        for (const [table, entries] of rows.entries())
          for (const [index, row] of entries.entries()) {
            if (typeof row.id === "string" && table !== 12) ids.set(row.id, `${table}:${index}`)
            if (table === 7) row.seq = index
            if (table === 2) {
              assert.strictEqual(row.doc_hash, docHash(JSON.parse(row.doc_json as string)))
              row.doc_hash = "verified from document"
            }
          }
        // Summary baseline hashes include source-slot UUIDs. Their complete stored
        // texts, revision history and coverage are compared above/below as ordinary rows.
        let summarySignature = 0
        for (const row of rows[10]!) {
          const payload = JSON.parse(row.payload_json as string)
          const summary = JSON.parse(payload.state).summary
          if (typeof summary === "string" && !ids.has(summary))
            ids.set(summary, `summary-signature:${summarySignature++}`)
        }
        const normalize = (value: unknown): unknown => {
          if (typeof value === "number" && value >= clockStart) return "clock"
          if (typeof value === "string") {
            const known = ids.get(value)
            if (known !== undefined) return known
            if (value.startsWith("{") || value.startsWith("[")) {
              try {
                return normalize(JSON.parse(value))
              } catch {
                /* ordinary text */
              }
            }
            return value.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, (id) => ids.get(id) ?? id)
          }
          if (Array.isArray(value)) return value.map(normalize)
          if (value !== null && typeof value === "object")
            return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, normalize(val)]))
          return value
        }
        return {
          rows: rows.map((table) => table.map(normalize)),
          report: normalize(report),
          library: normalize(library)
        }
      }).pipe(Effect.provide(serverLayer(config)), Effect.scoped)
    }
    return Effect.gen(function* () {
      for (const change of ["clean", "local", "swipe", "subset"] as const) {
        const positional = yield* run(false, change)
        const cached = yield* run(true, change)
        for (const [table, rows] of positional.rows.entries()) {
          assert.lengthOf(cached.rows[table]!, rows.length, `table ${table}`)
          for (const [row, expected] of rows.entries())
            assert.deepStrictEqual(cached.rows[table]![row], expected, `table ${table}, row ${row}`)
        }
        assert.deepStrictEqual(cached.report, positional.report)
        assert.deepStrictEqual(cached.library, positional.library)
      }
    })
  },
  120_000
)
