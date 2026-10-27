// ST's three kinds of note through the folder import (DESIGN §4.1, ARCHITECTURE §13): the
// chat's author's note, the card's Character's Note (`depth_prompt`) and the Character
// Author's Note from the settings (`note.chara`), and `allowWIScan`. A synthetic folder.
import { DatabaseSync } from "node:sqlite"
import { assert, layer } from "@effect/vitest"
import type { ChatId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { card, encode, header, jsonl, message } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"

const config = testConfig()

const query = (sql: string, ...args: Array<string>) => {
  const db = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
  try {
    return db.prepare(sql).all(...args)
  } finally {
    db.close()
  }
}

/** The head of every live note of a card, by the card's label. */
const cardNotes = (label: string) =>
  query(
    `SELECT h.doc_json FROM entities e JOIN entity_refs r ON r.entity_id = e.id AND r.ref_kind = 'upstream'
     JOIN entity_revisions h ON h.id = r.head_revision_id
     WHERE e.kind = 'note' AND e.deleted_at IS NULL AND json_extract(h.doc_json, '$.owner.card') =
       (SELECT r2.entity_id FROM entity_refs r2 JOIN entities e2 ON e2.id = r2.entity_id
        WHERE e2.kind = 'card' AND r2.label = ? AND r2.ref_kind = 'upstream')
     ORDER BY e.id`,
    label
  ).map((row) => JSON.parse(row.doc_json as string) as Record<string, unknown>)

const chatOf = (path: string) =>
  query(
    "SELECT json_extract(payload_json, '$.chatId') AS id FROM jobs WHERE json_extract(payload_json, '$.source') = ?",
    path
  )[0]?.id as ChatId

const say = (name: string, mes: string, minute: number, user = false) => message({ name, mes, minute, user })
const chat = (name: string, metadata: Record<string, unknown>) =>
  jsonl([header(metadata), say(name, `${name} looks up.`, 0), say("Sam", "Hello.", 1, true)])

const folder = (useAria: boolean) =>
  new Map<string, Uint8Array>([
    [
      "data/default-user/settings.json",
      encode({
        username: "Sam",
        extension_settings: {
          note: {
            default: "",
            defaultPosition: 1,
            defaultDepth: 4,
            defaultRole: 0,
            defaultInterval: 1,
            allowWIScan: true,
            chara: [
              { name: "Aria", prompt: "Aria hums when nervous.", useChara: useAria, position: 1 },
              { name: "Bram", prompt: "Bram limps.", useChara: false, position: 2 },
              { name: "Cato", prompt: "Cato speaks in riddles.", useChara: true, position: 0 },
              { name: "Nobody", prompt: "No card has this name.", useChara: true, position: 1 }
            ]
          }
        }
      })
    ],
    [
      "data/default-user/characters/Aria.png",
      card("Aria", "The lamp is lit.", {
        depth_prompt: { prompt: "Aria wears a grey coat.\nShe hates rain.", depth: 2, role: "system" }
      })
    ],
    ["data/default-user/characters/Bram.png", card("Bram", "Nets again.")],
    ["data/default-user/characters/Cato.png", card("Cato", "A riddle.")],
    // Aria's at frequency 3: on, every turn. Bram's at 0: off. Cato's empty: off, but kept.
    ["data/default-user/chats/Aria/Aria - one.jsonl", chat("Aria", { note_prompt: "Rain all day.", note_interval: 3 })],
    ["data/default-user/chats/Bram/Bram - one.jsonl", chat("Bram", { note_prompt: "Fog.", note_interval: 0 })],
    ["data/default-user/chats/Cato/Cato - one.jsonl", chat("Cato", { note_prompt: "", note_interval: 1 })],
    ["data/default-user/chats/Cato/Cato - two.jsonl", chat("Cato", { note_prompt: "Snow.", note_interval: 1 })],
    [
      "data/default-user/groups/g.json",
      encode({ id: "g", name: "Both", members: ["Aria.png", "Bram.png"], disabled_members: [], chats: ["Both - 1"] })
    ],
    [
      "data/default-user/group chats/Both - 1.jsonl",
      jsonl([
        header({}),
        message({ name: "Aria", mes: "Welcome.", minute: 0, avatar: "Aria.png" }),
        message({ name: "Sam", mes: "Thanks.", minute: 1, user: true }),
        message({ name: "Bram", mes: "Hm.", minute: 2, avatar: "Bram.png" })
      ])
    ]
  ])

layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })("ST notes on import", (it) => {
  it.effect("imports the three kinds of note by the owner's rules, and again without duplicates", () =>
    Effect.gen(function* () {
      const { report } = yield* importStFolder(folder(true))
      assert.deepStrictEqual(
        { ...report.counts.character_note },
        { added: 3, updated: 0, unchanged: 0, skipped: 0, failed: 0 }
      )

      // The Character's Note: on in every chat, scanned as ST's allowWIScan says.
      const [characterNote, aria] = cardNotes("Aria")
      assert.deepInclude(characterNote!, {
        title: "Character's Note",
        content: "Aria wears a grey coat.\nShe hates rain.",
        on_by_default: true,
        scan_lore: true
      })
      // The Character Author's Note: private, on where ST used it, at the chat note's top or bottom.
      assert.deepInclude(aria!, {
        title: "Character author's note",
        kind: "character_author_note",
        content: "Aria hums when nervous.",
        exportable: false,
        on_by_default: true,
        scan_lore: true,
        placement: { mode: "section", section: "author_note_top" }
      })
      const [bram] = cardNotes("Bram")
      assert.deepInclude(bram!, { on_by_default: false, placement: { mode: "section", section: "author_note_bottom" } })
      // ST's "replace" is kept at the top (owner question 5).
      const [cato] = cardNotes("Cato")
      assert.deepInclude(cato!, { on_by_default: true, placement: { mode: "section", section: "author_note_top" } })

      const api = yield* client()
      const notesIn = (path: string) =>
        Effect.map(api.ListChatNotes({ chatId: chatOf(path), slotId: null }), (notes) =>
          notes.map((n) => ({
            title: String(n.doc["title"]),
            card: n.card !== null,
            active: n.active,
            interval: n.doc["interval"],
            scan: n.doc["scan_lore"]
          }))
        )
      const aria1 = yield* notesIn("chats/Aria/Aria - one.jsonl")
      assert.deepStrictEqual(
        aria1.find((n) => n.title === "Author's Note"),
        {
          title: "Author's Note",
          card: false,
          active: true,
          interval: undefined,
          scan: true
        }
      )
      assert.isTrue(aria1.find((n) => n.title === "Character author's note")!.active)
      assert.isFalse((yield* notesIn("chats/Bram/Bram - one.jsonl")).find((n) => n.title === "Author's Note")!.active)
      assert.isFalse((yield* notesIn("chats/Cato/Cato - one.jsonl")).find((n) => n.title === "Author's Note")!.active)
      // ST ignores a character's own author's note in a group chat.
      const group = yield* notesIn("group chats/Both - 1.jsonl")
      assert.isFalse(group.find((n) => n.title === "Character author's note" && n.active) !== undefined)
      assert.isTrue(group.find((n) => n.title === "Character's Note")!.active)
      // The chat whose non-empty note ST replaced says so; the empty one doesn't.
      const replaced = report.issues.filter((issue) => issue.code === "st.character_note_replaced")
      assert.deepStrictEqual(
        replaced.map((issue) => issue.path),
        ["chats/Cato/Cato - two.jsonl"]
      )

      // Again, with Aria's unticked in ST: the same notes, updated, none added.
      const again = yield* importStFolder(folder(false))
      assert.strictEqual(again.report.counts.character_note?.added, 0)
      assert.strictEqual(again.report.counts.character_note?.updated, 3)
      assert.lengthOf(cardNotes("Aria"), 2)
      assert.strictEqual(cardNotes("Aria")[1]!.on_by_default, false)
    })
  )
})
