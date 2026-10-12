// The ST data folder import at the real boundary (ARCHITECTURE.md §13): a real server with
// its database and format workers, a synthetic ST folder (support/stFolder.ts) uploaded
// over HTTP as the client does, and the chats, library and report checked. Cross-user
// probes are in isolation.test.ts.
import { DatabaseSync } from "node:sqlite"
import { assert, describe, layer } from "@effect/vitest"
import { type ChatId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect, Stream } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { ALICE_MAIN, largeChat, stFolder } from "./support/stFolder.ts"
import { importStFolder, sendFile, sendStFile } from "./support/stUpload.ts"

const eventually = (check: () => boolean, ms = 10_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("timed out waiting"))
      yield* Effect.sleep(10)
    }
  })

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const jsonl = (...lines: ReadonlyArray<unknown>) =>
  new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n"))
const at = (minute: number) => new Date(Date.UTC(2025, 2, 1, 9, minute)).toISOString()
const line = (name: string, mes: string, minute: number) => ({
  name,
  is_user: name === "Sam",
  mes,
  send_date: at(minute)
})

/** The leaf of a chat, as the content of its selected version. */
const leafText = (chatId: ChatId) =>
  Effect.gen(function* () {
    const leaf = (yield* (yield* client()).GetChat({ chatId })).activeLeafSlotId
    return slots(chatId).find((s) => s.id === leaf)?.content
  })

const config = testConfig()
const folder = stFolder("ST/data/default-user/")

const db = () => new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })

const chatBySource = (source: string) => {
  const conn = db()
  const row = conn
    .prepare(
      "SELECT json_extract(payload_json, '$.chatId') AS chatId FROM jobs WHERE json_extract(payload_json, '$.source') = ?"
    )
    .get(source)
  conn.close()
  return row?.chatId as ChatId
}

/** Every slot of a chat with its selected text, in creation order. */
const slots = (chatId: ChatId) => {
  const conn = db()
  const rows = conn
    .prepare(
      `SELECT s.id, s.parent_slot_id AS parent, s.context_excluded AS hidden, v.content, v.speaker_entity_id AS speaker,
         v.writer, v.reasoning, (SELECT count(*) FROM versions w WHERE w.slot_id = s.id) AS versions
       FROM slots s JOIN versions v ON v.id = s.selected_version_id WHERE s.chat_id = ? ORDER BY s.depth, s.created_at, s.id`
    )
    .all(chatId)
  conn.close()
  return rows as Array<{
    id: SlotId
    parent: string | null
    hidden: number
    content: string
    speaker: string | null
    writer: string
    reasoning: string | null
    versions: number
  }>
}

const noteDocs = (chatId: ChatId) => {
  const conn = db()
  const rows = conn
    .prepare(
      `SELECT h.doc_json, (SELECT count(*) FROM entity_revisions x WHERE x.entity_id = e.id) AS revisions, e.id
       FROM entities e JOIN entity_refs r ON r.entity_id = e.id JOIN entity_revisions h ON h.id = r.head_revision_id
       WHERE e.kind = 'note' AND json_extract(h.doc_json, '$.owner.chat') = ? ORDER BY e.id`
    )
    .all(chatId)
  conn.close()
  return rows.map((row) => ({
    id: row.id as string,
    revisions: row.revisions as number,
    doc: JSON.parse(row.doc_json as string)
  }))
}

const entityByLabel = (label: string, tag?: string) => {
  const conn = db()
  const row = conn
    .prepare(
      `SELECT e.id FROM entities e JOIN entity_refs r ON r.entity_id = e.id WHERE r.label = ? AND r.ref_kind = 'upstream'
       ${tag ? "AND EXISTS (SELECT 1 FROM entity_tags t WHERE t.entity_id = e.id AND t.tag = ?)" : ""}`
    )
    .get(...(tag ? [label, tag] : [label]))
  conn.close()
  return row?.id as string
}

const stateAt = (chatId: ChatId, slotId: SlotId | null) =>
  Effect.gen(function* () {
    const reader = yield* Reader
    const user = yield* (yield* client()).Whoami()
    return foldState(yield* reader.StateEventsAt({ userId: user.id, chatId, slotId }))
  })

layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })("ST folder import", (it) => {
  it.effect("imports a folder: cards, personas, chats with branches and groups, state, summaries and the report", () =>
    Effect.gen(function* () {
      const { answers, report, api, importId } = yield* importStFolder(folder)
      const outcome = (path: string) => answers.get(path)?.outcome

      // The counts and the skips.
      assert.deepStrictEqual({ ...report.counts.card }, { added: 6, updated: 0, unchanged: 0, skipped: 0, failed: 0 })
      assert.deepStrictEqual(
        { ...report.counts.persona },
        { added: 2, updated: 0, unchanged: 0, skipped: 0, failed: 0 }
      )
      assert.strictEqual(report.counts.lorebook?.added, 1)
      assert.strictEqual(report.counts.preset?.added, 1)
      assert.deepStrictEqual({ ...report.counts.chat }, { added: 4, updated: 1, unchanged: 0, skipped: 1, failed: 0 })
      assert.strictEqual(report.counts.group_chat?.added, 1)
      assert.strictEqual(report.greetingOnly, 1)
      assert.sameDeepMembers(
        [...report.unsupported],
        [
          { what: "text-completion preset", count: 1 },
          { what: "instruct template", count: 1 }
        ]
      )
      assert.strictEqual(outcome("chats/Alice/Alice - greeting.jsonl"), "skipped")

      // The two cards named Twin can't be told apart; choosing one imports the chat.
      assert.strictEqual(outcome("chats/Twin/Twin - who.jsonl"), "needs_link")
      const [choice] = report.links
      assert.strictEqual(choice!.path, "chats/Twin/Twin - who.jsonl")
      assert.strictEqual(choice!.candidates.length, 2)
      const twin = folder.get("ST/data/default-user/chats/Twin/Twin - who.jsonl")!
      const chosen = yield* sendStFile(importId, "chats/Twin/Twin - who.jsonl", twin, {
        card: choice!.candidates[0]!.entityId
      })
      assert.strictEqual(chosen.outcome, "added")
      assert.lengthOf((yield* api.GetStImportReport({ importId })).links, 0)

      // Alice's chat and its branch are one graph: the branch shares three messages.
      const alice = chatBySource(`chats/Alice/${ALICE_MAIN}.jsonl`)
      assert.strictEqual(chatBySource(`chats/Alice/${ALICE_MAIN} - Branch #1.jsonl`), alice)
      const graph = slots(alice)
      assert.deepStrictEqual(
        graph.map((s) => s.content),
        [
          "Hello Sam, I am Alice.",
          "Hi Alice.",
          "Shall we walk?",
          "Yes.",
          "No, let's stay.",
          "To the river, then.",
          "As you wish."
        ]
      )
      const walk = graph.find((s) => s.content === "Shall we walk?")!
      assert.deepStrictEqual([walk.versions, walk.reasoning, walk.writer], [2, "She wants to move.", "model"])
      assert.strictEqual(graph.filter((s) => s.parent === graph.find((g) => g.content === "Hi Alice.")!.id).length, 1)
      assert.strictEqual(graph.filter((s) => s.parent === walk.id).length, 2)
      const aliceCard = entityByLabel("Alice")
      const sam = entityByLabel("Sam", "persona")
      assert.strictEqual(graph[0]!.speaker, aliceCard)
      assert.strictEqual(graph[1]!.speaker, sam)
      const chat = yield* api.GetChat({ chatId: alice })
      assert.strictEqual(chat.status, "active")
      assert.strictEqual(chat.activeLeafSlotId, graph.find((s) => s.content === "To the river, then.")!.id)
      // The branch has the latest message.
      assert.strictEqual(chat.lastMessageAt, Date.UTC(2025, 0, 1, 10, 6))

      // Its state: card and persona, the lorebook, variables, the author's note.
      const main = yield* stateAt(alice, chat.activeLeafSlotId)
      assert.sameMembers([...main.participants], [aliceCard, sam])
      assert.deepStrictEqual(main.playedByMe, [sam])
      assert.deepStrictEqual(main.vars, { mood: "calm", count: 3 })
      assert.lengthOf(main.lorebooks, 1)
      const notes = noteDocs(alice)
      const mainNote = notes.find((n) => n.doc.content === "Keep it gentle.")!
      assert.deepStrictEqual(main.activeNotes, [mainNote.id])
      assert.strictEqual(main.authorNote, mainNote.id)
      assert.deepStrictEqual(mainNote.doc.placement, { mode: "depth", depth: 2, role: "system" })
      assert.strictEqual(mainNote.doc.kind, "author_note")
      // The branch's own note replaces it from the branch's first new message on.
      const branch = yield* stateAt(alice, graph.find((s) => s.content === "As you wish.")!.id)
      const branchNote = notes.find((n) => n.doc.content === "Keep it tense.")!
      assert.deepStrictEqual(branch.activeNotes, [branchNote.id])

      // Bob's chat: fifteen messages hidden from the start, covered by its latest summary.
      const bob = chatBySource("chats/Bob/Bob - long.jsonl")
      const bobSlots = slots(bob)
      assert.strictEqual(bobSlots.filter((s) => s.hidden === 1).length, 15)
      const offer = report.hiddenRuns.find((run) => run.chatId === bob)!
      assert.deepStrictEqual([offer.hidden, offer.throughSlotId, offer.summaryCovers], [15, bobSlots[14]!.id, true])
      const [summary] = noteDocs(bob)
      assert.strictEqual(summary!.revisions, 2)
      assert.deepStrictEqual(summary!.doc, {
        schema_version: 1,
        title: "Summary",
        content: "Bob and Sam met, then argued.",
        placement: { mode: "depth", depth: 3, role: "system" },
        owner: { chat: bob },
        exportable: true,
        kind: "imported_summary",
        template: "[Story so far: {{summary}}]",
        covers: { first_slot_id: bobSlots[0]!.id, last_slot_id: bobSlots[14]!.id, slot_count: 15 },
        source_slot_id: bobSlots[14]!.id
      })
      assert.include((yield* stateAt(bob, null)).activeNotes, summary!.id)

      // Assembled, it sends what ST would on each path: at the end, the latest summary; on a
      // branch from before it, the one saved by then.
      const writer = yield* Writer
      const reader = yield* Reader
      const userId = (yield* api.Whoami()).id
      const sentAfter = (parentSlotId: SlotId) =>
        Effect.gen(function* () {
          const target = yield* writer.AppendMessage({
            userId,
            chatId: bob,
            parentSlotId,
            branch: true,
            version: new NewVersion({
              speakerEntityId: null,
              writer: "model",
              content: "",
              status: "generating",
              macroMode: "verbatim",
              origin: "generated"
            }),
            commitDraft: null
          })
          const { snapshot } = yield* reader.AssembleContext({
            userId,
            chatId: bob,
            slotId: target.slotId,
            versionId: target.version.id,
            now: Date.UTC(2026, 0, 1),
            timeZone: "UTC",
            frozen: null
          })
          return (JSON.parse(snapshot) as ContextSnapshot).request.messages.map((m) => m.content).join("\n")
        })
      const atEnd = yield* sentAfter(bobSlots.at(-1)!.id)
      assert.include(atEnd, "[Story so far: Bob and Sam met, then argued.]")
      assert.notInclude(atEnd, "On the last message")
      const early = yield* sentAfter(bobSlots[7]!.id)
      assert.notInclude(early, "then argued")
      assert.include(early, "[Story so far: Bob and Sam met.]")
      // Before the first, there's none to send.
      assert.notInclude(yield* sentAfter(bobSlots[6]!.id), "Story so far")
      assert.strictEqual(report.summaries, 2)

      // Mira's card file was renamed: linked by her name. Her summary covers no hidden run,
      // and her author's note (a summary she kept there) stays an author's note.
      const mira = chatBySource("chats/Mira/Mira - map.jsonl")
      assert.strictEqual(slots(mira)[0]!.speaker, entityByLabel("Mira"))
      const miraNotes = noteDocs(mira)
      assert.deepStrictEqual(
        miraNotes.map((n) => [n.doc.kind, n.doc.content, n.doc.placement, n.doc.covers]),
        [
          [
            "author_note",
            "Summary: Mira lost her map.",
            { mode: "section", section: "after_main_prompt", role: "system" },
            undefined
          ],
          ["imported_summary", "Mira is looking for her map.", { mode: "depth", depth: 3, role: "system" }, undefined]
        ]
      )
      assert.isUndefined(report.hiddenRuns.find((run) => run.chatId === mira))

      // A folder no card is named after: linked by the greeting, with the speaking persona.
      const ghost = chatBySource("chats/Ghost/Ghost - lamp.jsonl")
      assert.deepStrictEqual(
        slots(ghost).map((s) => s.speaker),
        [entityByLabel("Wren"), entityByLabel("Kim", "persona")]
      )

      // The group chat: both members, the muted one absent, speakers by their avatars.
      const party = chatBySource("group chats/Party - 2025.jsonl")
      const bobCard = entityByLabel("Bob")
      assert.deepStrictEqual(
        slots(party).map((s) => s.speaker),
        [aliceCard, sam, bobCard, aliceCard]
      )
      const partyState = yield* stateAt(party, null)
      assert.sameMembers([...partyState.participants], [aliceCard, bobCard, sam])
      assert.deepStrictEqual(partyState.absent, [bobCard])
      assert.deepStrictEqual(partyState.vars, { scene: "inn" })
      assert.strictEqual((yield* api.GetChat({ chatId: party })).title, "Party: Party - 2025")

      // Personas: in the persona folder, with their avatars; Kim's description at depth.
      const conn = db()
      const kim = conn
        .prepare(
          `SELECT h.doc_json FROM entity_refs r JOIN entity_revisions h ON h.id = r.head_revision_id
           WHERE json_extract(h.doc_json, '$.owner.card') = ?`
        )
        .get(entityByLabel("Kim", "persona"))
      const samCard = conn
        .prepare(
          `SELECT h.doc_json FROM entity_refs r JOIN entity_revisions h ON h.id = r.head_revision_id WHERE r.entity_id = ?`
        )
        .get(sam)
      conn.close()
      assert.deepStrictEqual(JSON.parse(kim!.doc_json as string).placement, { mode: "depth", depth: 3, role: "user" })
      const samDoc = JSON.parse(samCard!.doc_json as string)
      assert.strictEqual(samDoc.description, "Sam is curious.")
      assert.isString(samDoc.avatar_media_id)

      // Accepting the offer un-hides the run, and the report drops it. An open tab reads
      // the chat again.
      const events: Array<string> = []
      yield* api.SubscribeChat({ chatId: bob }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch.map((e) => e._tag)))),
        Effect.forkScoped
      )
      yield* eventually(() => events.includes("Hello"))
      const unhidden = yield* api.UnhideImportedRun({ chatId: bob, throughSlotId: offer.throughSlotId })
      assert.strictEqual(unhidden.unhidden, 15)
      yield* eventually(() => events.includes("Reload"))
      assert.strictEqual(slots(bob).filter((s) => s.hidden === 1).length, 0)
      assert.isUndefined((yield* api.GetStImportReport({ importId })).hiddenRuns.find((run) => run.chatId === bob))
    }).pipe(Effect.scoped)
  )

  it.effect("imports the same folder again without duplicating anything, chats sent in small parts", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const before = yield* api.ListChats({ limit: 500, before: null })
      const library = yield* api.ListLibrary({ kind: "card" })
      const { report } = yield* importStFolder(folder, { partBytes: 600 })
      assert.deepStrictEqual({ ...report.counts.card }, { added: 0, updated: 0, unchanged: 6, skipped: 0, failed: 0 })
      assert.strictEqual(report.counts.chat?.added ?? 0, 0)
      assert.strictEqual(report.counts.chat?.updated ?? 0, 0)
      assert.strictEqual(report.counts.chat?.unchanged, 5)
      const after = yield* api.ListChats({ limit: 500, before: null })
      assert.deepStrictEqual(after.map((c) => c.id).sort(), before.map((c) => c.id).sort())
      assert.lengthOf(yield* api.ListLibrary({ kind: "card" }), library.length)
      assert.strictEqual(slots(chatBySource(`chats/Alice/${ALICE_MAIN}.jsonl`)).length, 7)
    })
  )

  it.effect("a chat sent in many parts is the same as one sent whole, and continues where ST went on", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { importId } = yield* api.StartStImport({ unsupported: [] })
      const card = folder.get("ST/data/default-user/characters/Alice.png")!
      yield* sendStFile(importId, "characters/Alice.png", card)
      const chat = largeChat(300)
      assert.strictEqual((yield* sendStFile(importId, "chats/Alice/large.jsonl", chat, {}, 16_384)).outcome, "added")
      const chatId = chatBySource("chats/Alice/large.jsonl")
      const imported = slots(chatId)
      assert.lengthOf(imported, 300)
      assert.isTrue(imported.every((slot, i) => slot.content.startsWith(`${i}: `)))
      // ST went on with the chat: the re-import adds only the new messages, and the leaf moves.
      const longer = largeChat(310)
      assert.strictEqual(
        (yield* sendStFile(importId, "chats/Alice/large.jsonl", longer, {}, 16_384)).outcome,
        "updated"
      )
      assert.lengthOf(slots(chatId), 310)
      const leaf = (yield* api.GetChat({ chatId })).activeLeafSlotId
      assert.strictEqual(
        slots(chatId)
          .find((s) => s.id === leaf)!
          .content.slice(0, 5),
        "309: "
      )
    })
  )

  it.effect("a chat ST replaced the end of moves its leaf to the new end; one continued here keeps its own", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const send = (path: string, bytes: Uint8Array) =>
        Effect.flatMap(api.StartStImport({ unsupported: [] }), ({ importId }) =>
          sendStFile(importId, path, bytes, { card: "none" })
        )
      const head = [
        { chat_metadata: {} },
        line("Rue", "g", 0),
        line("Sam", "u1", 1),
        line("Rue", "r1", 2),
        line("Sam", "u2", 3)
      ]
      assert.strictEqual((yield* send("chats/Rue/a.jsonl", jsonl(...head, line("Rue", "r2", 4)))).outcome, "added")
      const chatId = chatBySource("chats/Rue/a.jsonl")
      // In ST, r2 was swiped away for r2b, and the chat went on.
      const replaced = jsonl(...head, line("Rue", "r2b", 5), line("Sam", "u3", 6))
      assert.strictEqual((yield* send("chats/Rue/a.jsonl", replaced)).outcome, "updated")
      assert.strictEqual(yield* leafText(chatId), "u3")
      // Continued here: a later re-import with more from ST leaves the leaf alone.
      const leaf = (yield* api.GetChat({ chatId })).activeLeafSlotId!
      yield* api.SendMessage({ chatId, parentSlotId: leaf, branch: false, content: "here" })
      assert.strictEqual(
        (yield* send(
          "chats/Rue/a.jsonl",
          jsonl(...head, line("Rue", "r2b", 5), line("Sam", "u3", 6), line("Rue", "r3", 7))
        )).outcome,
        "updated"
      )
      assert.strictEqual(yield* leafText(chatId), "here")
    })
  )

  it.effect("a re-import cut off halfway is finished by the next run, its state from the first new message", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const head = [line("Ivy", "g", 0), line("Sam", "u1", 1), line("Ivy", "r1", 2), line("Sam", "u2", 3)]
      const first = yield* api.StartStImport({ unsupported: [] })
      yield* sendStFile(first.importId, "chats/Ivy/a.jsonl", jsonl({ chat_metadata: {} }, ...head), { card: "none" })
      const chatId = chatBySource("chats/Ivy/a.jsonl")
      const u2 = slots(chatId).find((s) => s.content === "u2")!.id
      // ST went on, with a new author's note; the first part arrives and the rest never does.
      const longer = jsonl(
        { chat_metadata: { note_prompt: "New note." } },
        ...head,
        line("Ivy", "r2", 4),
        line("Sam", "u3", 5),
        line("Ivy", "r3", 6)
      )
      const cut = new TextEncoder().encode(new TextDecoder().decode(longer).split("\n").slice(0, 7).join("\n") + "\n")
      const second = yield* api.StartStImport({ unsupported: [] })
      const partial = yield* sendFile(second.importId, "chats/Ivy/a.jsonl", cut, { part: "0", last: "0", card: "none" })
      assert.strictEqual(((yield* Effect.promise(() => partial.json())) as { outcome: string }).outcome, "continue")
      // A new run sends the whole file.
      const third = yield* api.StartStImport({ unsupported: [] })
      assert.strictEqual(
        (yield* sendStFile(third.importId, "chats/Ivy/a.jsonl", longer, { card: "none" })).outcome,
        "updated"
      )
      assert.strictEqual(yield* leafText(chatId), "r3")
      const r2 = slots(chatId).find((s) => s.content === "r2")!.id
      const note = noteDocs(chatId).find((n) => n.doc.content === "New note.")!
      assert.notInclude((yield* stateAt(chatId, u2)).activeNotes, note.id)
      assert.include((yield* stateAt(chatId, r2)).activeNotes, note.id)
    })
  )

  it.effect("a chat whose import never finished stays, marked so, until an import finishes it", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { importId } = yield* api.StartStImport({ unsupported: [] })
      const first = jsonl({ chat_metadata: {} }, line("Oak", "g", 0), line("Sam", "u", 1))
      yield* sendFile(importId, "chats/Oak/a.jsonl", first, { part: "0", last: "0", card: "none" })
      const chatId = chatBySource("chats/Oak/a.jsonl")
      const chat = yield* api.GetChat({ chatId })
      assert.deepStrictEqual([chat.status, chat.title], ["active", "a (import unfinished)"])
      // Deleted by the user, it goes to the recycle bin like any chat, and the import leaves it there.
      yield* api.DeleteChat({ chatId })
      const rest = jsonl(line("Oak", "r", 2))
      const next = yield* sendFile(importId, "chats/Oak/a.jsonl", rest, { part: "1", last: "1", card: "none" })
      assert.strictEqual(((yield* Effect.promise(() => next.json())) as { outcome: string }).outcome, "skipped")
    })
  )

  it.effect("bounds what one file or one import can make the server hold or do", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { importId } = yield* api.StartStImport({ unsupported: [] })
      // A new speaker on every line: past the cap, messages have none, and the import is quick.
      const crowd = jsonl(
        { chat_metadata: {} },
        ...Array.from({ length: 1500 }, (_, i) => line(i === 1 ? "Sam" : `n${i}`, `m${i}`, i))
      )
      assert.strictEqual((yield* sendStFile(importId, "chats/Crowd/a.jsonl", crowd, { card: "none" })).outcome, "added")
      const report = yield* api.GetStImportReport({ importId })
      assert.isTrue(report.issues.some((issue) => issue.code === "st_chat.speakers_dropped"))
      // Group files can't pile up past the import's budget.
      const names = Array.from({ length: 900 }, (_, i) => `${i}`.padStart(1000, "x"))
      let refused = 0
      for (let i = 0; i < 40 && refused === 0; i++) {
        const answer = yield* sendStFile(importId, `groups/g${i}.json`, encode({ id: `g${i}`, chats: names }))
        if (answer.outcome === "failed") refused = i
      }
      assert.isAbove(refused, 10)
      assert.isTrue((yield* api.GetStImportReport({ importId })).issues.some((issue) => issue.code === "st.too_much"))
    })
  )

  describe("hostile requests", () => {
    it.effect("refuses paths the import doesn't read, before reading the body", () =>
      Effect.gen(function* () {
        const { importId } = yield* (yield* client()).StartStImport({ unsupported: [] })
        for (const path of [
          "secrets.json",
          "../settings.json",
          "chats/../../x.jsonl",
          "backups/a.jsonl",
          "instruct/a.json"
        ]) {
          const response = yield* sendFile(importId, path, new Uint8Array([1]))
          assert.strictEqual(response.status, 400, path)
        }
        const unknown = yield* sendFile("00000000-0000-7000-8000-000000000000", "settings.json", new Uint8Array([1]))
        assert.strictEqual(unknown.status, 404)
        const big = yield* sendFile(
          importId,
          "chats/A/a.jsonl",
          new Uint8Array(1),
          { part: "0", last: "1" },
          {
            "content-length": String(8 * 1024 * 1024 + 1)
          }
        ).pipe(Effect.catchDefect(() => Effect.succeed(null)))
        if (big !== null) assert.strictEqual(big.status, 413)
        const outOfOrder = yield* sendFile(importId, "chats/A/a.jsonl", new Uint8Array([10]), { part: "1", last: "0" })
        assert.strictEqual(
          (yield* Effect.promise(() => outOfOrder.json() as Promise<{ outcome: string }>)).outcome,
          "restart"
        )
      })
    )
  })
  it.effect("keeps imported roles beside the main prompt for author notes and summaries", () =>
    Effect.gen(function* () {
      const api = yield* client()
      for (const [position, role] of [
        [0, 1],
        [2, 2]
      ] as const) {
        const { importId } = yield* api.StartStImport({ unsupported: [] })
        const settings = {
          extension_settings: {
            memory: { position, role, depth: 2, template: "[{{summary}}]" },
            disabledExtensions: []
          }
        }
        yield* sendStFile(importId, "settings.json", encode(settings))
        yield* sendStFile(
          importId,
          "characters/Mira_new.png",
          folder.get("ST/data/default-user/characters/Mira_new.png")!
        )
        const path = `chats/Mira_new/roles-${position}.jsonl`
        yield* sendStFile(
          importId,
          path,
          jsonl(
            {
              user_name: "Sam",
              character_name: "Mira",
              chat_metadata: {
                note_prompt: "Author",
                note_position: position,
                note_role: role,
                note_depth: 4,
                note_interval: 1
              }
            },
            line("Mira", "Greeting", 0),
            { ...line("Sam", "Question", 1), extra: { memory: "Summary" } },
            line("Mira", "Reply", 2)
          )
        )
        const docs = noteDocs(chatBySource(path))
        assert.lengthOf(docs, 2)
        for (const { doc } of docs)
          assert.deepStrictEqual(doc.placement, {
            mode: "section",
            section: position === 0 ? "after_main_prompt" : "before_main_prompt",
            role: role === 1 ? "user" : "assistant"
          })
      }
    })
  )
})
