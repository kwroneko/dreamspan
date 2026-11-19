// An ST branch family whose author's note grew over time (owner, 2026-11-01): each file's
// author's note is the chat's one note, with the text that file had in its own fork. Before,
// each file whose note differed made a note of its own, and every fork listed them all: its
// own on, the others off, one of them missing the paragraphs added later.
import { DatabaseSync } from "node:sqlite"
import { assert, layer } from "@effect/vitest"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { forkRequests } from "./support/forkRequests.ts"
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

const say = (name: string, mes: string, minute: number, user = false) => message({ name, mes, minute, user })
const note = (prompt: string) => ({
  note_prompt: prompt,
  note_position: 1,
  note_depth: 1,
  note_role: 0,
  note_interval: 1
})

const FIRST = "The road is long."
const SECOND = `${FIRST}\n\nIt rains at night.`
const THIRD = `${SECOND}\n\nThe inn is full.`
const MAIN = "Ivo - road"
const opening = [say("Ivo", "We walk.", 0), say("Sam", "Onward.", 1, true), say("Ivo", "Mind the mud.", 2)]

/** Main, a branch of it with a longer note, and a branch of that with a longer one still. */
const folder = (later = false) =>
  new Map<string, Uint8Array>(
    (
      [
        ["settings.json", encode({ username: "Sam" })],
        ["characters/Ivo.png", card("Ivo", "We walk.")],
        [
          `chats/Ivo/${MAIN}.jsonl`,
          jsonl([
            header(note(later ? `${FIRST} Mostly uphill.` : FIRST)),
            ...opening,
            ...(later ? [say("Sam", "Still walking.", 9, true)] : [])
          ])
        ],
        [
          `chats/Ivo/${MAIN} - Branch #1.jsonl`,
          jsonl([
            header({ ...note(SECOND), main_chat: MAIN }),
            ...opening,
            say("Sam", "Let's camp.", 3, true),
            say("Ivo", "Here, then.", 4)
          ])
        ],
        [
          `chats/Ivo/${MAIN} - Branch #1 - Branch #2.jsonl`,
          jsonl([
            header({ ...note(THIRD), main_chat: `${MAIN} - Branch #1` }),
            ...opening,
            say("Sam", "Let's camp.", 3, true),
            say("Ivo", "Here, then.", 4),
            say("Sam", "Or the inn?", 5, true)
          ])
        ]
      ] as const
    ).map(([path, bytes]) => [`data/default-user/${path}`, bytes])
  )

layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })("ST branch notes", (it) => {
  it.effect("each fork shows the author's note its own file had, as the chat's one note", () =>
    Effect.gen(function* () {
      yield* importStFolder(folder())
      const api = yield* client()
      const [chat] = yield* api.ListChats({ limit: 10, before: null })
      const chatId = chat!.id as ChatId
      const forks = (yield* api.ListForks({ chatId })).toSorted((a, b) => a.createdAt - b.createdAt)
      assert.lengthOf(forks, 3)

      const shown = (forkId: (typeof forks)[number]["id"], slotId: (typeof forks)[number]["tipSlotId"]) =>
        Effect.map(api.ListChatNotes({ chatId, forkId, slotId }), (notes) =>
          notes
            .filter((n) => n.card === null)
            .map((n) => ({ title: n.doc["title"], content: n.doc["content"], active: n.active }))
        )
      const expected = [FIRST, SECOND, THIRD]
      for (const [index, fork] of forks.entries())
        assert.deepStrictEqual(yield* shown(fork.id, fork.tipSlotId), [
          { title: "Author's Note", content: expected[index], active: true }
        ])
      // One note entity, whatever the fork.
      const owned = query(
        `SELECT count(*) AS n FROM entities e JOIN entity_refs r ON r.entity_id = e.id
         JOIN entity_revisions h ON h.id = r.head_revision_id
         WHERE e.kind = 'note' AND json_extract(h.doc_json, '$.owner.chat') = ?`,
        chatId
      )
      assert.strictEqual(owned[0]!.n, 1)
      // A re-import whose main file's note changed, with a message to attach it to: the same
      // note, its new text in the main fork only.
      yield* importStFolder(folder(true))
      const again = (yield* api.ListForks({ chatId })).toSorted((a, b) => a.createdAt - b.createdAt)
      assert.deepStrictEqual(yield* shown(again[0]!.id, again[0]!.tipSlotId), [
        { title: "Author's Note", content: `${FIRST} Mostly uphill.`, active: true }
      ])
      assert.deepStrictEqual(yield* shown(again[1]!.id, again[1]!.tipSlotId), [
        { title: "Author's Note", content: SECOND, active: true }
      ])
      assert.strictEqual(
        query(
          `SELECT count(*) AS n FROM entities e JOIN entity_refs r ON r.entity_id = e.id
           JOIN entity_revisions h ON h.id = r.head_revision_id
           WHERE e.kind = 'note' AND json_extract(h.doc_json, '$.owner.chat') = ?`,
          chatId
        )[0]!.n,
        1
      )
      // Nothing marks it: no state key, no kind.
      assert.strictEqual(query(`SELECT count(*) AS n FROM state_events WHERE key = 'author_note.set'`)[0]!.n, 0)
      assert.strictEqual(
        query(`SELECT count(*) AS n FROM entity_revisions WHERE json_extract(doc_json, '$.kind') = 'author_note'`)[0]!
          .n,
        0
      )
      // Each fork sends its own text, once.
      const requests = yield* forkRequests
      const sentTexts = [`${FIRST} Mostly uphill.`, SECOND, THIRD]
      for (const [index, text] of sentTexts.entries()) {
        const sent = JSON.stringify(requests[`${MAIN} #${index}`])
        assert.include(sent, JSON.stringify(text).slice(1, -1))
        for (const other of sentTexts.filter((t) => t !== text && !text.startsWith(t)))
          assert.notInclude(sent, JSON.stringify(other).slice(1, -1))
      }
    })
  )
})
