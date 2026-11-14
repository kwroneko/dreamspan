// Independent differential oracle. Run this same synthetic scenario on master and on the
// candidate with ST_REIMPORT_PARITY_OUT, then compare the JSON files. No real data is read.
import { writeFileSync } from "node:fs"
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { docHash } from "../src/db/documents.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { card, header, jsonl, largeChat, message, stFolder } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"

const config = testConfig()
const turns = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    message({
      name: i % 2 ? "Sam" : "Alice",
      user: i % 2 === 1,
      mes: `Synthetic ${i}`,
      minute: i,
      ...(i % 2 ? {} : { swipes: [`Synthetic ${i}`, `Alternate ${i}`] })
    })
  )
const chat = (lines: ReadonlyArray<unknown>, parent?: string) =>
  jsonl([header(parent ? { main_chat: parent } : {}), ...lines])
const snapshots: unknown[] = []
/**
 * With ST_REIMPORT_PARITY_CONFIRMED=1, every import is checked first and held to the check
 * (the re-import preview): the state it leaves must be what the unconfirmed import leaves.
 */
const checked = process.env.ST_REIMPORT_PARITY_CONFIRMED === "1"
const reimport = (files: ReadonlyMap<string, Uint8Array>, options: { partBytes?: number } = {}) =>
  importStFolder(files, { ...options, ...(checked ? { checked } : {}) })

layer(serverLayer(config), { excludeTestServices: true, timeout: "10 minutes" })(
  "ST master differential state",
  (it) => {
    it.effect("retains full state across the corpus and adversarial reimports", () =>
      Effect.gen(function* () {
        const started = Date.now()
        const api = yield* client()
        const owner = (yield* api.Whoami()).id
        const ids = new Map<string, string>([[owner, "owner"]])
        const [catalog] = yield* fixtureSql(
          config.dataDir,
          [
            {
              // What a confirmed import holds while it reads a file is gone once it's written.
              sql: "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name <> 'st_import_stage' ORDER BY name"
            }
          ],
          { readOnly: true }
        )
        const tables = [...catalog!.map((row) => String(row.name)), "version_records"]
        const capture = (label: string) =>
          Effect.gen(function* () {
            yield* api.GetShellLibrary()
            const rows = yield* fixtureSql(
              config.dataDir,
              [
                ...tables.map((table) => ({ sql: `SELECT * FROM ${table}` })),
                { sql: "SELECT * FROM jobs WHERE kind = 'st-import-chat' ORDER BY id" },
                { sql: "SELECT v.id, f.content FROM versions v JOIN versions_fts f ON f.rowid=v.seq ORDER BY v.seq" },
                { sql: "PRAGMA foreign_key_check" }
              ],
              { readOnly: true }
            )
            assert.deepStrictEqual(rows.at(-1), [])
            for (const [table, entries] of rows.entries())
              for (const [index, row] of entries.entries())
                if (typeof row.id === "string" && !ids.has(row.id)) ids.set(row.id, `${table}:${index}`)
            for (const entries of rows)
              for (const row of entries) {
                if (typeof row.doc_hash === "string" && typeof row.doc_json === "string") {
                  assert.strictEqual(
                    row.doc_hash,
                    docHash(JSON.parse(row.doc_json)),
                    "stored document hashes must be correct before normalizing UUID-dependent fingerprints"
                  )
                  if (!ids.has(row.doc_hash)) ids.set(row.doc_hash, `document-fingerprint:${ids.size}`)
                }
              }
            for (const row of rows[tables.indexOf("jobs")] ?? []) {
              if (row.kind !== "st-import-chat") continue
              const payload = JSON.parse(String(row.payload_json))
              const summary = payload.state ? JSON.parse(payload.state).summary : null
              if (typeof summary === "string" && !ids.has(summary)) ids.set(summary, `summary-baseline:${ids.size}`)
            }
            const normalize = (value: unknown): unknown => {
              if (typeof value === "number" && value >= started - 60_000) return "clock"
              if (typeof value === "string") {
                if (
                  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) &&
                  Date.parse(value.replace(" ", "T") + "Z") >= started - 60_000
                )
                  return "clock"
                if (ids.has(value)) return ids.get(value)
                if (value.startsWith("{") || value.startsWith("[")) {
                  try {
                    return normalize(JSON.parse(value))
                  } catch {
                    /* literal text */
                  }
                }
                return value.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, (id) => {
                  if (!ids.has(id)) ids.set(id, `related:${ids.size}`)
                  return ids.get(id)!
                })
              }
              if (Array.isArray(value)) return value.map(normalize)
              if (value !== null && typeof value === "object")
                return Object.fromEntries(
                  Object.entries(value).map(([k, v]) => [
                    k.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, (id) => {
                      if (!ids.has(id)) ids.set(id, `related:${ids.size}`)
                      return ids.get(id)!
                    }),
                    normalize(v)
                  ])
                )
              return value
            }
            snapshots.push({ label, rows: normalize(rows) })
          })
        // Existing import corpus includes groups, notes, hidden runs, summaries and missing links.
        yield* reimport(stFolder())
        yield* capture("corpus")
        yield* reimport(stFolder(), { partBytes: 600 })
        yield* capture("corpus replay")
        const files = new Map([
          ["characters/Alice.png", card("Alice", "Synthetic greeting.")],
          ["chats/Alice/Parity.jsonl", chat(turns(205))],
          ["chats/Alice/Duplicate.jsonl", chat(turns(205))],
          ["chats/Alice/Side.jsonl", chat([...turns(104), ...turns(4)], "Parity")],
          ["chats/Alice/Orphan.jsonl", chat(turns(8), "Missing")],
          ["chats/Alice/Long.jsonl", largeChat(1001)],
          ["chats/Alice/Malformed.jsonl", new TextEncoder().encode("{bad json\nnull\n")]
        ])
        yield* reimport(files, { partBytes: 8192 })
        yield* capture("duplicate orphan branches malformed long")
        const main = (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title === "Parity")!
        const entries = (yield* api.ReadPath({
          chatId: main.id,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 300
        })).entries
        yield* api.SetMessageHidden({ slotId: entries[2]!.slotId, hidden: true })
        yield* api.EditVersion({
          slotId: entries[4]!.slotId,
          sourceVersionId: entries[4]!.version.id,
          content: "Local edit",
          images: [],
          expectedRowVersion: entries[4]!.rowVersion
        })
        yield* api.DeleteMessage({ slotId: entries[6]!.slotId })
        const binned = yield* api.DeleteMessage({ slotId: entries[8]!.slotId })
        yield* api.PurgeBinItem({ itemId: binned.id })
        yield* api.CreateFork({ chatId: main.id, fromForkId: main.currentForkId, atSlotId: entries[100]!.slotId })
        yield* capture("local fork edit hide delete purge")
        const later = turns(208)
        later[10] = message({
          name: "Alice",
          mes: "Alternate 10",
          minute: 10,
          swipes: ["Alternate 10", "Synthetic 10"],
          swipeId: 0
        })
        later[12] = message({ name: "Alice", mes: "Edited in ST", minute: 12, hidden: true, swipes: ["Edited in ST"] })
        files.set("chats/Alice/Parity.jsonl", chat(later))
        files.set("chats/Alice/Renamed.jsonl", chat(later))
        files.set("chats/Alice/Late.jsonl", chat([...later.slice(0, 207), ...turns(3)], "Parity"))
        yield* reimport(files, { partBytes: 8192 })
        yield* capture("edited reordered renamed late branch")
        yield* reimport(files, { partBytes: 8192 })
        yield* capture("adversarial replay")
        if (process.env.ST_REIMPORT_PARITY_OUT)
          writeFileSync(process.env.ST_REIMPORT_PARITY_OUT, JSON.stringify(snapshots, null, 1))
        assert.lengthOf(snapshots, 6)
      })
    )
  }
)
