// The author's note without a special role (owner, 2026-11-01), on a database master's code
// made, and on a fresh import of the same synthetic folder.
//
// `fixtures/authorNote/master.db.gz` is what master (e6ef53ff) wrote importing
// `authorNoteFolder()` and then `authorNoteFolder("Rain all night.", true)`, with lore "only
// below the history" turned off in every chat but the plain and quiet ones
// (`loreWherePlaced`). `master-requests.json` is the request each fork then assembled on
// master. Migration 0004 converts that database at startup.
import { DatabaseSync } from "node:sqlite"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { gunzipSync } from "node:zlib"
import { assert, describe, layer } from "@effect/vitest"
import { Effect } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import { authorNoteFolder } from "./support/authorNoteFolder.ts"
import { serverLayer, testConfig } from "./support/config.ts"
import { forkRequests, loreWherePlaced, type RequestMessage } from "./support/forkRequests.ts"
import { importStFolder } from "./support/stUpload.ts"

const fixture = (name: string) => new URL(`./fixtures/authorNote/${name}`, import.meta.url)

/** Master's requests, keyed as `forkRequests` keys them. */
const masterRequests = (() => {
  const raw = JSON.parse(readFileSync(fixture("master-requests.json"), "utf8")) as Record<
    string,
    { readonly chat: string; readonly fork: string; readonly messages: ReadonlyArray<RequestMessage> }
  >
  const out: Record<string, ReadonlyArray<RequestMessage>> = {}
  const seen = new Map<string, number>()
  // Written in chat title order, each chat's forks by creation, as `forkRequests` reads them.
  for (const [key, value] of Object.entries(raw)) {
    const title = key.split(" :: ")[0]!
    const index = seen.get(title) ?? 0
    seen.set(title, index + 1)
    out[`${title} #${index}`] = value.messages.map(({ role, content }) => ({ role, content }))
  }
  return out
})()

const system = (content: string) => ({ role: "system", content })
const lore = "Lore at depth one.\nLore after the note.\nLore before the note."
const riders = "Aria wears a grey coat.\nAria hums when nervous.\nSam is tall and patient."
const mainNote = (note: string) => ({
  [`Sam is tall and patient.\nAria hums when nervous.\nLore before the note.\n${note}\nLore after the note.\nAria wears a grey coat.\nLore at depth one.`]:
    [system(`${note}\n${riders}\n${lore}`)]
})

/**
 * How the requests differ from master's, by the master message each change replaces; every
 * other message is byte for byte master's. What rode on the author's note is at its depth and
 * role now, joined in the order notes and lore at one depth always join (the chat's notes, the
 * cards', the personas', then lore) rather than around the author's note's text. A card's note
 * and lore have one place in every chat: the group chat's author's note is at depth 2, but the
 * persona and the lore went to depth 1, where most of the chats have it. Beside the main
 * prompt, a card's note goes with its card's definition (`Bram - one`).
 */
const CONVERTED: Record<string, Record<string, ReadonlyArray<RequestMessage>>> = {
  "Aria - main #0": mainNote("Rain all night."),
  "Aria - main #1": mainNote("Snow now."),
  "Aria - main #2": mainNote("Rain all day."),
  "Aria - plain #0": {
    "Sam is tall and patient.\nAria hums when nervous.\nAria wears a grey coat.": [system(riders)]
  },
  "Both: Both - 1 #0": {
    "Sam is tall and patient.\nLore before the note.\nCrowded room.\nLore after the note.": [system("Crowded room.")],
    "Aria wears a grey coat.\nLore at depth one.": [
      system(`Aria wears a grey coat.\nSam is tall and patient.\n${lore}`)
    ]
  },
  "Bram - one #0": {
    "Dust storm.\nBram limps.\nRook keeps a ledger.": [
      { role: "user", content: "Dust storm." },
      system("<Rook>\nRook keeps a ledger.\n</Rook>")
    ],
    "<Bram>\nBram is made up for a test.\n</Bram>": [
      system("<Bram>\nBram limps.\nBram is made up for a test.\n</Bram>")
    ]
  }
}

/**
 * A fresh import places a card's note and lore where the folder's default author's note is
 * (depth 1 as the system), not where its chats' are: only `Bram - one` differs from the
 * conversion, and its import report says so (`st.author_note_riders`).
 */
const IMPORTED: typeof CONVERTED = {
  ...CONVERTED,
  "Bram - one #0": {
    "Dust storm.\nBram limps.\nRook keeps a ledger.": [{ role: "user", content: "Dust storm." }],
    "I brought the ledger.": [
      system("Bram limps.\nRook keeps a ledger."),
      { role: "user", content: "I brought the ledger." }
    ]
  }
}

/** Master's requests with `changes` applied. */
const expected = (changes: typeof CONVERTED) =>
  Object.fromEntries(
    Object.entries(masterRequests).map(([key, messages]) => [
      key,
      messages.flatMap((m) => changes[key]?.[m.content as string] ?? [m])
    ])
  )

describe("a database master's code made", () => {
  const config = testConfig()
  const file = databaseFile(config.dataDir)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, gunzipSync(readFileSync(fixture("master.db.gz"))))
  const query = (sql: string) => {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      return db.prepare(sql).all()
    } finally {
      db.close()
    }
  }

  layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })("converted at startup", (it) => {
    it.effect("places what rode on the author's note concretely, drops the marks, and sends what master sent", () =>
      Effect.gen(function* () {
        assert.strictEqual(query(`SELECT count(*) AS n FROM state_events WHERE key = 'author_note.set'`)[0]!.n, 0)
        // Every live head is concrete; master's revisions keep their documents.
        const heads = (where: string) =>
          query(`SELECT h.doc_json FROM entity_refs r JOIN entity_revisions h ON h.id = r.head_revision_id
            JOIN entities e ON e.id = r.entity_id WHERE ${where} ORDER BY e.id`).map(
            (row) => JSON.parse(row.doc_json as string) as Record<string, unknown>
          )
        const notes = heads(`e.kind = 'note'`)
        assert.isFalse(JSON.stringify(notes).includes("author_note_"))
        const placed = (title: string, content: string) =>
          notes.find((n) => n["title"] === title && n["content"] === content)?.["placement"]
        // Most of the chats with each card have their author's note at depth 1 as the system.
        assert.deepStrictEqual(placed("Persona description", "Sam is tall and patient."), {
          mode: "depth",
          depth: 1,
          role: "system"
        })
        assert.deepStrictEqual(placed("Character author's note", "Aria hums when nervous."), {
          mode: "depth",
          depth: 1,
          role: "system"
        })
        // Bram's chats: his own (after the main prompt, as the user) and the group (depth 2): a tie, the first.
        assert.deepStrictEqual(placed("Character author's note", "Bram limps."), {
          mode: "section",
          section: "after_main_prompt",
          role: "user"
        })
        const [book] = heads(`e.kind = 'lorebook'`)
        assert.deepStrictEqual(
          (book!["entries"] as Array<Record<string, unknown>>).map(({ position, depth, role }) => ({
            position,
            depth,
            role
          })),
          [
            { position: "at_depth", depth: 1, role: "system" },
            { position: "at_depth", depth: 1, role: "system" },
            { position: "at_depth", depth: 1, role: "system" }
          ]
        )
        assert.isAbove(
          query(`SELECT count(*) AS n FROM entity_revisions WHERE doc_json LIKE '%author_note_top%'`)[0]!.n as number,
          0
        )
        assert.deepStrictEqual(yield* forkRequests, expected(CONVERTED))
      })
    )
  })
})

describe("a fresh import", () => {
  layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "180 seconds" })("with this code", (it) => {
    it.effect("places what ST put at the author's note where the default one is, kept", () =>
      Effect.gen(function* () {
        const { report } = yield* importStFolder(authorNoteFolder())
        assert.deepStrictEqual(
          report.issues.filter((issue) => issue.code === "st.author_note_riders").map((issue) => issue.path),
          ["chats/Bram/Bram - one.jsonl", "group chats/Both - 1.jsonl"]
        )
        yield* importStFolder(authorNoteFolder("Rain all night.", true))
        yield* loreWherePlaced(["plain", "quiet"])
        assert.deepStrictEqual(yield* forkRequests, expected(IMPORTED))
      })
    )
  })
})
