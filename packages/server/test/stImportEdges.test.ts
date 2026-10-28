// The ST folder import's harder cases (ARCHITECTURE.md §13), each from a review that found
// it wrong: resuming and re-importing branches and orphans, notes that go away, branches
// that differ from their parent only in a swipe or a hidden flag, greeting-only chats split
// across parts, hostile dates, and what one import may hold or write at once.
import { DatabaseSync } from "node:sqlite"
import { currentForkSql, selectedInSql } from "../src/db/forkState.ts"
import { Worker } from "node:worker_threads"
import { assert, layer } from "@effect/vitest"
import type { ChatId, SlotId, VersionId } from "@rp/shared/chat.ts"
import { DraftKey } from "@rp/shared/drafts.ts"
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { foldState } from "@rp/shared/state.ts"
import { Deferred, Effect, Fiber } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { Formats } from "../src/importer/Formats.ts"
import { removeOldStaging } from "../src/importer/StImports.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { tempDir } from "./support/tempDir.ts"
import { importStFolder, sendFile, sendStFile } from "./support/stUpload.ts"

const config = testConfig()
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const jsonl = (...lines: ReadonlyArray<unknown>) =>
  new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n"))
const message = (mes: string, n: number, extra: object = {}) => ({
  name: n % 2 ? "User" : "Bot",
  is_user: n % 2 === 1,
  mes,
  send_date: 1_730_000_000_000 + n,
  ...extra
})

const query = (sql: string, ...args: Array<string | number>) => {
  const db = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
  try {
    return db.prepare(sql).all(...args)
  } finally {
    db.close()
  }
}
const chatOf = (path: string) =>
  query(
    "SELECT json_extract(payload_json, '$.chatId') AS id FROM jobs WHERE json_extract(payload_json, '$.source') = ?",
    path
  )[0]?.id as ChatId
/** The version slot `s` shows in its chat's current fork. */
const SHOWN = selectedInSql(currentForkSql("s.chat_id"), "s")
const shownAt = (slotId: string) => query(`SELECT ${SHOWN} AS id FROM slots s WHERE s.id = ?`, slotId)[0]!.id
const textOf = (slotId: string | null) =>
  query(`SELECT v.content FROM slots s JOIN versions v ON v.id = ${SHOWN} WHERE s.id = ?`, slotId ?? "")[0]?.content
/** The path ending at the slot showing `text`: each slot's selected text and whether it's hidden. */
const pathTo = (text: string) =>
  query(
    `WITH RECURSIVE p(id, parent, depth) AS (
       SELECT s.id, s.parent_slot_id, s.depth FROM slots s JOIN versions v ON v.id = ${SHOWN} WHERE v.content = ?
       UNION ALL SELECT s.id, s.parent_slot_id, s.depth FROM slots s JOIN p ON s.id = p.parent)
     SELECT v.content, s.context_excluded AS hidden FROM p JOIN slots s ON s.id = p.id
       JOIN versions v ON v.id = ${SHOWN} ORDER BY p.depth`,
    text
  ) as Array<{ content: string; hidden: number }>
const notesOf = (chatId: ChatId) =>
  query("SELECT doc_json FROM entity_revisions WHERE json_extract(doc_json, '$.owner.chat') = ?", chatId).map(
    (row) => JSON.parse(row.doc_json as string) as { content: string; template?: string }
  )

const begin = Effect.gen(function* () {
  const api = yield* client()
  return { api, ...(yield* api.StartStImport({ unsupported: [] })) }
})
const leafText = (chatId: ChatId) =>
  Effect.gen(function* () {
    const api = yield* client()
    return textOf((yield* api.GetChat({ chatId })).activeLeafSlotId)
  })
const stateAtLeaf = (chatId: ChatId) =>
  Effect.gen(function* () {
    const api = yield* client()
    const user = yield* api.Whoami()
    const leaf = (yield* api.GetChat({ chatId })).activeLeafSlotId
    return foldState(yield* (yield* Reader).StateEventsAt({ userId: user.id, chatId, slotId: leaf }))
  })
/** A statement on the test's database from another connection, off this thread. */
const exec = (statement: string) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const worker = new Worker(
          `const { workerData, parentPort } = require("node:worker_threads")
           const { DatabaseSync } = require("node:sqlite")
           const db = new DatabaseSync(workerData.file)
           try { db.exec(workerData.statement) } finally { db.close() }
           parentPort.postMessage("done")`,
          { eval: true, workerData: { file: databaseFile(config.dataDir), statement } }
        )
        worker.once("message", () => resolve())
        worker.once("error", reject)
      })
  )
const present = (content: string) =>
  Number(query("SELECT count(*) AS n FROM versions WHERE content = ?", content)[0]!.n)
const answer = (response: Response) => Effect.promise(() => response.json() as Promise<{ outcome: string }>)

layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })("ST import edges", (it) => {
  it.effect("an orphan stays a chat of its own: a re-import moves its leaf, a resumed import gives it one", () =>
    Effect.gen(function* () {
      const path = "chats/Bot/orphan.jsonl"
      const header = { chat_metadata: { main_chat: "missing" } }
      const first = yield* begin
      yield* sendStFile(first.importId, path, jsonl(header, message("g", 0), message("u", 1)), {
        card: "none",
        orphan: "1"
      })
      const second = yield* begin
      const later = jsonl(header, message("g", 0), message("u", 1), message("later", 2))
      assert.strictEqual(
        (yield* sendStFile(second.importId, path, later, { card: "none", orphan: "1" })).outcome,
        "updated"
      )
      assert.strictEqual(yield* leafText(chatOf(path)), "later")

      const cut = "chats/Bot/interrupted-orphan.jsonl"
      const bytes = jsonl({ chat_metadata: { main_chat: "absent" } }, message("g", 0), message("u", 1))
      const third = yield* begin
      yield* answer(yield* sendFile(third.importId, cut, bytes, { card: "none", orphan: "1", last: "0" }))
      const fourth = yield* begin
      assert.strictEqual(
        (yield* sendStFile(fourth.importId, cut, bytes, { card: "none", orphan: "1" })).outcome,
        "added"
      )
      assert.strictEqual(yield* leafText(chatOf(cut)), "u")
    })
  )

  it.effect("a branch whose import was cut off keeps its own note when it's finished", () =>
    Effect.gen(function* () {
      const first = yield* begin
      const root = jsonl(
        { chat_metadata: { note_prompt: "parent note" } },
        message("g", 0),
        message("u", 1),
        message("main", 2)
      )
      yield* sendStFile(first.importId, "chats/Bot/root.jsonl", root, { card: "none" })
      const child = jsonl(
        { chat_metadata: { main_chat: "root", note_prompt: "child note" } },
        message("g", 0),
        message("u", 1),
        message("child", 2)
      )
      // Every message of the branch is written before the import stops.
      yield* answer(yield* sendFile(first.importId, "chats/Bot/child.jsonl", child, { card: "none", last: "0" }))
      const second = yield* begin
      yield* sendStFile(second.importId, "chats/Bot/child.jsonl", child, { card: "none" })
      const chatId = chatOf("chats/Bot/child.jsonl")
      assert.include(
        notesOf(chatId).map((note) => note.content),
        "child note"
      )
      const user = yield* second.api.Whoami()
      const childSlot = query(
        `SELECT s.id FROM slots s JOIN versions v ON v.id = ${SHOWN} WHERE v.content = 'child'`
      )[0]!.id as never
      const state = foldState(yield* (yield* Reader).StateEventsAt({ userId: user.id, chatId, slotId: childSlot }))
      // On the branch, its own note applies, not its parent's.
      const childNote = query(
        "SELECT entity_id FROM entity_revisions WHERE json_extract(doc_json, '$.content') = 'child note'"
      )[0]!
      assert.deepStrictEqual(state.activeNotes, [childNote.entity_id as string])
    })
  )

  it.effect("an author's note emptied in ST keeps its settings, off, from the new messages on", () =>
    Effect.gen(function* () {
      const path = "chats/Bot/note-clear.jsonl"
      const first = yield* begin
      yield* sendStFile(
        first.importId,
        path,
        jsonl({ chat_metadata: { note_prompt: "old note" } }, message("g", 0), message("u", 1)),
        {
          card: "none"
        }
      )
      const second = yield* begin
      const cleared = jsonl(
        { chat_metadata: { note_prompt: "" } },
        message("g", 0),
        message("u", 1),
        message("later", 2)
      )
      yield* sendStFile(second.importId, path, cleared, { card: "none" })
      // Kept, for what rides on the author's note, but off: ST sends nothing of an empty one.
      const state = yield* stateAtLeaf(chatOf(path))
      assert.lengthOf(state.activeNotes, 0)
      assert.isNotNull(state.authorNote)
      const doc = query(
        "SELECT doc_json FROM entity_revisions WHERE entity_id = ? ORDER BY created_at DESC LIMIT 1",
        state.authorNote!
      )[0]!
      assert.strictEqual((JSON.parse(doc.doc_json as string) as { content: string }).content, "")
    })
  )

  it.effect("a greeting-only chat is skipped however its parts fall", () =>
    Effect.gen(function* () {
      const { importId } = yield* begin
      const bytes = jsonl({ chat_metadata: {} }, message("g".repeat(300), 0))
      assert.strictEqual(
        (yield* sendStFile(importId, "chats/Bot/greeting-parts.jsonl", bytes, { card: "none" }, 380)).outcome,
        "skipped"
      )
      yield* answer(
        yield* sendFile(importId, "chats/Bot/only-greeting.jsonl", jsonl({ chat_metadata: {} }), {
          card: "none",
          last: "0"
        })
      )
      const last = yield* sendFile(importId, "chats/Bot/only-greeting.jsonl", jsonl(message("g", 0)), {
        card: "none",
        part: "1",
        last: "1"
      })
      assert.strictEqual((yield* answer(last)).outcome, "skipped")
      assert.isUndefined(chatOf("chats/Bot/only-greeting.jsonl"))
      assert.isUndefined(chatOf("chats/Bot/greeting-parts.jsonl"))
    })
  )

  it.effect("a chat sent again from its first part in the same import goes on in the same chat", () =>
    Effect.gen(function* () {
      const { importId } = yield* begin
      const path = "chats/Bot/restart.jsonl"
      yield* answer(
        yield* sendFile(importId, path, jsonl({ chat_metadata: {} }, message("g", 0), message("u", 1)), {
          card: "none",
          last: "0"
        })
      )
      yield* sendStFile(
        importId,
        path,
        jsonl({ chat_metadata: {} }, message("g", 0), message("u", 1), message("r", 2)),
        { card: "none" }
      )
      assert.lengthOf(query("SELECT id FROM jobs WHERE json_extract(payload_json, '$.source') = ?", path), 1)
      assert.lengthOf(query("SELECT id FROM chats WHERE title = 'restart'"), 1)
    })
  )

  it.effect("a branch from another swipe, or hiding messages its parent shows, keeps them on its own path", () =>
    Effect.gen(function* () {
      const { importId } = yield* begin
      const base = [message("greeting", 0), message("user", 1)]
      const swipes = { swipes: ["choice A", "choice B"] }
      yield* sendStFile(
        importId,
        "chats/Bot/swipe-main.jsonl",
        jsonl(
          { chat_metadata: {} },
          ...base,
          message("choice A", 2, { ...swipes, swipe_id: 0 }),
          message("main continuation", 3)
        ),
        { card: "none" }
      )
      yield* sendStFile(
        importId,
        "chats/Bot/swipe-child.jsonl",
        jsonl(
          { chat_metadata: { main_chat: "swipe-main" } },
          ...base,
          message("choice B", 2, { ...swipes, swipe_id: 1 }),
          message("branch continuation", 3)
        ),
        { card: "none" }
      )
      assert.deepStrictEqual(
        pathTo("branch continuation").map((s) => s.content),
        ["greeting", "user", "choice B", "branch continuation"]
      )
      assert.deepStrictEqual(
        pathTo("main continuation").map((s) => s.content),
        ["greeting", "user", "choice A", "main continuation"]
      )

      const shown = Array.from({ length: 10 }, (_, i) => message(`shown-${i}`, i))
      yield* sendStFile(
        importId,
        "chats/Bot/hidden-main.jsonl",
        jsonl({ chat_metadata: {} }, ...shown, message("main-tail", 11)),
        { card: "none" }
      )
      const hidden = shown.map((m) => ({ ...m, is_system: true }))
      yield* sendStFile(
        importId,
        "chats/Bot/hidden-child.jsonl",
        jsonl({ chat_metadata: { main_chat: "hidden-main" } }, ...hidden, message("child-tail", 11)),
        { card: "none" }
      )
      assert.strictEqual(pathTo("child-tail").filter((s) => s.hidden === 1).length, 10)
      assert.strictEqual(pathTo("main-tail").filter((s) => s.hidden === 1).length, 0)
    })
  )

  it.effect("a timestamp past what a date holds is no timestamp", () =>
    Effect.gen(function* () {
      const { importId } = yield* begin
      const bytes = jsonl({ chat_metadata: {} }, message("g", 0), message("hostile date", 1, { send_date: 1e100 }))
      const response = yield* sendFile(importId, "chats/Bot/date.jsonl", bytes, { card: "none" })
      assert.strictEqual(response.status, 200)
      assert.strictEqual((yield* answer(response)).outcome, "added")
      // It takes the time of the message before it.
      assert.deepStrictEqual(
        query("SELECT v.created_at FROM versions v WHERE v.content = 'hostile date'").map((r) => r.created_at),
        [1_730_000_000_000]
      )
    })
  )

  it.effect("a chat's summaries count against what one import may hold", () =>
    Effect.gen(function* () {
      const { importId } = yield* begin
      let outcome = "continue"
      let parts = 0
      for (; parts < 20 && outcome === "continue"; parts++) {
        const lines = [
          ...(parts === 0 ? [{ chat_metadata: {} }] : []),
          message(`u${parts}`, 1, { extra: { memory: `${parts}:${"s".repeat(1024 * 1024)}` } })
        ]
        outcome = (yield* answer(
          yield* sendFile(importId, "chats/Bot/summaries.jsonl", jsonl(...lines), {
            card: "none",
            part: String(parts),
            last: "0"
          })
        )).outcome
      }
      assert.strictEqual(outcome, "failed")
      assert.isBelow(parts, 20)
      // The budget comes back once the chat is dropped.
      const group = yield* sendStFile(importId, "groups/after.json", json({ id: "after", chats: ["after"] }))
      assert.strictEqual(group.outcome, "added")
    })
  )

  it.effect("a summary's history is stored once and bounded, however long its template", () =>
    Effect.gen(function* () {
      const { importId } = yield* begin
      const settings = json({ extension_settings: { memory: { template: `${"x".repeat(128 * 1024)}{{summary}}` } } })
      yield* sendStFile(importId, "settings.json", settings)
      const lines = Array.from({ length: 1001 }, (_, i) =>
        message(`m${i}`, i, { extra: { memory: `summary ${i} ${"y".repeat(2000)}` } })
      )
      const bytes = jsonl({ chat_metadata: {} }, ...lines)
      yield* sendStFile(importId, "chats/Bot/amplification.jsonl", bytes, { card: "none" })
      const notes = notesOf(chatOf("chats/Bot/amplification.jsonl"))
      const stored = notes.reduce((sum, note) => sum + JSON.stringify(note).length, 0)
      assert.strictEqual(notes.filter((note) => note.template !== undefined).length, 1)
      assert.isBelow(stored, 512 * 1024)
      assert.isBelow(stored, settings.length + bytes.length)
    })
  )

  it.effect("a chain of branches sorted the wrong way imports with linear uploads", () =>
    Effect.gen(function* () {
      const files = new Map<string, Uint8Array>()
      for (let i = 0; i <= 20; i++) {
        const name = String(i).padStart(3, "0")
        const header = { chat_metadata: i === 20 ? {} : { main_chat: String(i + 1).padStart(3, "0") } }
        files.set(
          `group chats/${name}.jsonl`,
          jsonl(header, message("greeting", 0), message("user", 1), message(`branch ${i}`, 2 + i))
        )
      }
      const original = globalThis.fetch
      let uploads = 0
      globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
        if (String(args[0]).includes("/st-import/file?")) uploads++
        return original(...args)
      }) as typeof fetch
      try {
        const { report } = yield* importStFolder(files)
        assert.deepStrictEqual(
          { ...report.counts.group_chat },
          { added: 1, updated: 20, unchanged: 0, skipped: 0, failed: 0 }
        )
        assert.strictEqual(uploads, files.size)
      } finally {
        globalThis.fetch = original
      }
    })
  )
  it.effect("an unchanged branch that went its own way re-imports without a slot more", () =>
    Effect.gen(function* () {
      const first = yield* begin
      const base = [message("re-g", 0), message("re-u", 1)]
      const swipes = { swipes: ["re-A", "re-B"] }
      yield* sendStFile(
        first.importId,
        "chats/Bot/re-root.jsonl",
        jsonl({ chat_metadata: {} }, ...base, message("re-A", 2, { ...swipes, swipe_id: 0 }), message("re-end", 3)),
        { card: "none" }
      )
      const swipe = jsonl(
        { chat_metadata: { main_chat: "re-root" } },
        ...base,
        message("re-B", 2, { ...swipes, swipe_id: 1 }),
        message("re-branch-end", 3)
      )
      const hidden = jsonl(
        { chat_metadata: { main_chat: "re-root" } },
        ...base.map((m) => ({ ...m, is_system: true })),
        message("re-hidden-end", 3)
      )
      yield* sendStFile(first.importId, "chats/Bot/re-swipe.jsonl", swipe, { card: "none" })
      yield* sendStFile(first.importId, "chats/Bot/re-hidden.jsonl", hidden, { card: "none" })
      const slots = () =>
        query("SELECT count(*) AS n FROM slots WHERE chat_id = ?", chatOf("chats/Bot/re-root.jsonl"))[0]!.n
      const before = slots()
      const second = yield* begin
      assert.strictEqual(
        (yield* sendStFile(second.importId, "chats/Bot/re-swipe.jsonl", swipe, { card: "none" })).outcome,
        "unchanged"
      )
      assert.strictEqual(
        (yield* sendStFile(second.importId, "chats/Bot/re-hidden.jsonl", hidden, { card: "none" })).outcome,
        "unchanged"
      )
      assert.strictEqual(slots(), before)
    })
  )

  it.effect("a branch cut off and sent again in the same import keeps its own note", () =>
    Effect.gen(function* () {
      const first = yield* begin
      const root = jsonl(
        { chat_metadata: { note_prompt: "same parent note" } },
        message("sg", 0),
        message("su", 1),
        message("sparent", 2)
      )
      yield* sendStFile(first.importId, "chats/Bot/same-root.jsonl", root, { card: "none" })
      const child = jsonl(
        { chat_metadata: { main_chat: "same-root", note_prompt: "same child note" } },
        message("sg", 0),
        message("su", 1),
        message("schild", 2)
      )
      yield* answer(yield* sendFile(first.importId, "chats/Bot/same-child.jsonl", child, { card: "none", last: "0" }))
      yield* sendStFile(first.importId, "chats/Bot/same-child.jsonl", child, { card: "none" })
      assert.include(
        notesOf(chatOf("chats/Bot/same-child.jsonl")).map((note) => note.content),
        "same child note"
      )
    })
  )

  it.effect("a chat that fails gives back what its summaries held", () =>
    Effect.gen(function* () {
      const { importId } = yield* begin
      const path = "chats/Bot/fails.jsonl"
      for (let part = 0; part < 16; part++) {
        const lines = [
          ...(part === 0 ? [{ chat_metadata: {} }] : []),
          message(`fail-${part}`, 1, { extra: { memory: "s".repeat(1024 * 1024 - 1024) } })
        ]
        const sent = yield* answer(
          yield* sendFile(importId, path, jsonl(...lines), { card: "none", part: String(part), last: "0" })
        )
        assert.strictEqual(sent.outcome, "continue")
      }
      yield* exec(
        "CREATE TRIGGER st_test_fail BEFORE INSERT ON versions WHEN NEW.content = 'explode' BEGIN SELECT RAISE(ABORT, 'test'); END"
      )
      const failed = yield* sendFile(importId, path, jsonl(message("explode", 1)), {
        card: "none",
        part: "16",
        last: "1"
      }).pipe(Effect.ensuring(exec("DROP TRIGGER st_test_fail")))
      assert.strictEqual(failed.status, 500)
      const big = Array.from({ length: 60 }, (_, i) => `${i}:${"g".repeat(1000)}`)
      assert.strictEqual(
        (yield* sendStFile(importId, "groups/after-fail.json", json({ id: "after", chats: big }))).outcome,
        "added"
      )
    })
  )

  it.effect("a chat of two or more messages without a user turn goes in, however its parts fall", () =>
    Effect.gen(function* () {
      const { importId, api } = yield* begin
      const path = "chats/Bot/all-model.jsonl"
      yield* answer(yield* sendFile(importId, path, jsonl({ chat_metadata: {} }), { card: "none", last: "0" }))
      yield* answer(yield* sendFile(importId, path, jsonl(message("am-0", 0)), { card: "none", part: "1", last: "0" }))
      const done = yield* answer(
        yield* sendFile(importId, path, jsonl(message("am-2", 2)), { card: "none", part: "2", last: "1" })
      )
      assert.strictEqual(done.outcome, "added")
      assert.deepStrictEqual(
        pathTo("am-2").map((row) => row.content),
        ["am-0", "am-2"]
      )
      const report = yield* api.GetStImportReport({ importId })
      // A detail, not something to act on: the report doesn't list it (DESIGN §1.4).
      assert.isFalse(report.issues.some((issue) => issue.path === path))
      assert.strictEqual(report.greetingOnly, 0)
    })
  )

  it.effect("a chat of one message goes in when the user wrote it", () =>
    Effect.gen(function* () {
      const { importId } = yield* begin
      const path = "chats/Bot/one-user-message.jsonl"
      const done = yield* sendStFile(importId, path, jsonl({ chat_metadata: {} }, message("oum-1", 1)), {
        card: "none"
      })
      assert.strictEqual(done.outcome, "added")
      assert.strictEqual(present("oum-1"), 1)
    })
  )

  it.effect("a greeting-only file is skipped onto a chat an earlier import made, writing nothing", () =>
    Effect.gen(function* () {
      const path = "chats/Bot/greeting-reimport.jsonl"
      const first = yield* begin
      yield* sendStFile(first.importId, path, jsonl({ chat_metadata: {} }, message("gre-g", 0), message("gre-u", 1)), {
        card: "none"
      })
      const slots = query("SELECT count(*) AS n FROM slots WHERE chat_id = ?", chatOf(path))[0]!.n
      const second = yield* begin
      const again = yield* sendStFile(
        second.importId,
        path,
        jsonl({ chat_metadata: { note_prompt: "new" } }, message("gre-only", 0)),
        { card: "none" }
      )
      assert.strictEqual(again.outcome, "skipped")
      assert.strictEqual(present("gre-only"), 0)
      assert.strictEqual(query("SELECT count(*) AS n FROM slots WHERE chat_id = ?", chatOf(path))[0]!.n, slots)
      assert.lengthOf(notesOf(chatOf(path)), 0)
    })
  )

  it.effect("a summary's history keeps its placement; how it's sent and what it covers are current-only", () =>
    Effect.gen(function* () {
      const { importId, api } = yield* begin
      const path = "chats/Bot/placement.jsonl"
      const hidden = Array.from({ length: 10 }, (_, i) =>
        message(`placed-${i}`, i, { is_system: true, extra: { memory: `summary ${i}` } })
      )
      yield* sendStFile(importId, path, jsonl({ chat_metadata: {} }, ...hidden, message("placed-tail", 11)), {
        card: "none"
      })
      const docs = query(
        "SELECT doc_json FROM entity_revisions WHERE json_extract(doc_json, '$.owner.chat') = ? ORDER BY seq",
        chatOf(path)
      ).map((row) => JSON.parse(row.doc_json as string) as Record<string, unknown>)
      assert.lengthOf(docs, 10)
      assert.isTrue(docs.every((doc) => doc.placement !== undefined))
      assert.deepStrictEqual(
        docs.map((doc) => [doc.template !== undefined, doc.covers !== undefined]),
        docs.map((_, i) => [i === 9, i === 9])
      )
      // Without settings.json the summary is placed as ST's defaults place it, which the note shows: the report doesn't list it.
      const report = yield* api.GetStImportReport({ importId })
      assert.isFalse(report.issues.some((issue) => issue.code === "st.summary_defaults"))
    })
  )
  it.effect("nothing an unfinished import wrote is ever removed, whatever the user did with it", () =>
    Effect.gen(function* () {
      const first = yield* begin
      const path = "chats/Bot/kept.jsonl"
      const head = [
        message("kept-g", 0, { swipes: ["kept-g", "kept-alt"], swipe_id: 0 }),
        message("kept-u", 1),
        message("kept-r", 2),
        message("kept-u2", 3)
      ]
      yield* answer(
        yield* sendFile(first.importId, path, jsonl({ chat_metadata: {} }, ...head), { card: "none", last: "0" })
      )
      const chatId = chatOf(path)
      // Visible, and says it's unfinished; its leaf shows what came in.
      const listed = (yield* first.api.ListChats({ limit: 500, before: null })).find((chat) => chat.id === chatId)!
      assert.strictEqual(listed.title, "kept (import unfinished)")
      assert.strictEqual(yield* leafText(chatId), "kept-u2")

      // The user works on it meanwhile.
      const user = yield* first.api.Whoami()
      const writer = yield* Writer
      const slotOf = (text: string) =>
        query("SELECT s.id FROM slots s JOIN versions v ON v.slot_id = s.id WHERE v.content = ?", text)[0]!.id as SlotId
      const versionOf = (text: string) => query("SELECT id FROM versions WHERE content = ?", text)[0]!.id as VersionId
      yield* writer.AmendVersion({
        userId: user.id,
        versionId: versionOf("kept-u"),
        content: "kept-u amended",
        expectedRowVersion: 1
      })
      const alt = versionOf("kept-alt")
      const greeting = slotOf("kept-g")
      const shown = shownAt(greeting)
      yield* writer.SelectVersion({
        userId: user.id,
        slotId: greeting,
        versionId: alt,
        expectedVersionId: shown as VersionId
      })
      const key = new DraftKey({ targetKind: "version_edit", targetId: versionOf("kept-r"), field: "" })
      yield* writer.SaveDraft({
        draftId: null,
        expectedSession: null,
        userId: user.id,
        key,
        content: "an unsaved edit",
        expectedRowVersion: null,
        baseRevision: null
      })
      yield* first.api.DeleteMessage({ slotId: slotOf("kept-u2") })

      // A new import run says it's unfinished, and finishes it.
      const second = yield* begin
      assert.isTrue(
        (yield* second.api.GetStImportReport({ importId: second.importId })).issues.some(
          (i) => i.code === "st.unfinished"
        )
      )
      const rest = jsonl({ chat_metadata: {} }, ...head, message("kept-r2", 4))
      assert.strictEqual((yield* sendStFile(second.importId, path, rest, { card: "none" })).outcome, "added")
      assert.strictEqual((yield* second.api.GetChat({ chatId })).title, "kept")
      assert.strictEqual(present("kept-u amended"), 1)
      assert.lengthOf(query("SELECT id FROM version_history WHERE version_id = ?", versionOf("kept-u amended")), 1)
      assert.strictEqual(shownAt(greeting), alt)
      assert.isNotNull(yield* (yield* Reader).GetDraft({ userId: user.id, key }))
      assert.lengthOf(query("SELECT id FROM slots WHERE id = ? AND deleted_at IS NOT NULL", slotOf("kept-u2")), 1)
    })
  )

  it.effect("an import run another took over, or that finished, writes nothing more", () =>
    Effect.gen(function* () {
      const { importId, api } = yield* begin
      const path = "chats/Bot/leased.jsonl"
      const lines = [message("lease-g", 0), message("lease-u", 1)]
      yield* answer(
        yield* sendFile(importId, path, jsonl({ chat_metadata: {} }, ...lines), { card: "none", last: "0" })
      )
      const user = yield* api.Whoami()
      const writer = yield* Writer
      const chatId = chatOf(path)
      const recordId = query("SELECT id FROM jobs WHERE json_extract(payload_json, '$.source') = ?", path)[0]!
        .id as string
      const batch = (lease: string) =>
        writer.StImportMessages({
          userId: user.id,
          chatId,
          recordId,
          lease,
          advanceLeaf: false,
          strict: false,
          parentSlotId: null,
          matching: true,
          speakers: {},
          messagesJson: JSON.stringify([
            {
              user: false,
              hidden: false,
              speaker: null,
              selected: 0,
              versions: [{ content: "lease-g", at: 1_730_000_000_000, reasoning: null }]
            }
          ])
        })
      const second = yield* begin
      yield* writer.StImportClaim({ userId: user.id, recordId, lease: second.importId })
      assert.strictEqual((yield* Effect.flip(batch(importId)))._tag, "ImportLeaseLost")
      // The new run finishes the file; then no run may write it, not even that one.
      yield* sendStFile(second.importId, path, jsonl({ chat_metadata: {} }, ...lines, message("lease-r", 2)), {
        card: "none"
      })
      assert.strictEqual((yield* Effect.flip(batch(second.importId)))._tag, "ImportLeaseLost")
      assert.strictEqual((yield* Effect.flip(batch(importId)))._tag, "ImportLeaseLost")
    })
  )

  it.effect("a run the user started another since claims nothing, not even a finished record", () =>
    Effect.gen(function* () {
      const path = "chats/Bot/stale-claim.jsonl"
      const lines = [message("sc-g", 0), message("sc-u", 1)]
      const seed = yield* begin
      yield* sendStFile(seed.importId, path, jsonl({ chat_metadata: {} }, ...lines), { card: "none" })
      const user = yield* seed.api.Whoami()
      const writer = yield* Writer
      const recordId = query("SELECT id FROM jobs WHERE json_extract(payload_json, '$.source') = ?", path)[0]!
        .id as string
      const stale = yield* begin
      yield* begin
      assert.strictEqual(
        (yield* Effect.flip(writer.StImportClaim({ userId: user.id, recordId, lease: stale.importId })))._tag,
        "ImportLeaseLost"
      )
      assert.isNull(
        query("SELECT json_extract(payload_json, '$.lease') AS lease FROM jobs WHERE id = ?", recordId)[0]!.lease
      )
    })
  )

  it.effect("an upload admitted before the user started another import writes nothing after it", () =>
    Effect.gen(function* () {
      const path = "chats/Bot/stale-upload.jsonl"
      const lines = [message("su-g", 0), message("su-u", 1)]
      const seed = yield* begin
      yield* sendStFile(seed.importId, path, jsonl({ chat_metadata: {} }, ...lines), { card: "none" })
      const stale = yield* begin
      const formats = yield* Formats
      const st = formats.st as { chatPart: typeof formats.st.chatPart }
      const original = st.chatPart
      const entered = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      try {
        // The stale run's part is parsed, and waits, while the user starts another import.
        st.chatPart = (input) =>
          original(input).pipe(
            Effect.tap(() => Deferred.succeed(entered, undefined)),
            Effect.tap(() => Deferred.await(release))
          )
        const pending = yield* Effect.forkChild(
          sendFile(stale.importId, path, jsonl({ chat_metadata: {} }, ...lines, message("su-stale", 2)), {
            card: "none"
          }).pipe(Effect.flatMap(answer))
        )
        yield* Deferred.await(entered)
        yield* stale.api.StartStImport({ unsupported: [] })
        yield* Deferred.succeed(release, undefined)
        assert.strictEqual((yield* Fiber.join(pending)).outcome, "failed")
        assert.strictEqual(present("su-stale"), 0)
      } finally {
        st.chatPart = original
      }
    })
  )

  it.effect("a greeting-only branch is skipped without writing anything into its parent's chat", () =>
    Effect.gen(function* () {
      const { importId } = yield* begin
      yield* sendStFile(
        importId,
        "chats/Bot/greet-root.jsonl",
        jsonl({ chat_metadata: {} }, message("gr-g", 0), message("gr-u", 1)),
        { card: "none" }
      )
      const chatId = chatOf("chats/Bot/greet-root.jsonl")
      const slots = query("SELECT count(*) AS n FROM slots WHERE chat_id = ?", chatId)[0]!.n
      const header = { chat_metadata: { main_chat: "greet-root" } }
      yield* answer(yield* sendFile(importId, "chats/Bot/greet-only.jsonl", jsonl(header), { card: "none", last: "0" }))
      const skipped = yield* answer(
        yield* sendFile(importId, "chats/Bot/greet-only.jsonl", jsonl(message("gr-other", 0)), {
          card: "none",
          part: "1",
          last: "1"
        })
      )
      assert.strictEqual(skipped.outcome, "skipped")
      assert.isUndefined(chatOf("chats/Bot/greet-only.jsonl"))
      assert.strictEqual(present("gr-other"), 0)
      assert.strictEqual(query("SELECT count(*) AS n FROM slots WHERE chat_id = ?", chatId)[0]!.n, slots)
    })
  )
  it.effect("a new chat finished by another run ends with its leaf on its last message, however its parts fell", () =>
    Effect.gen(function* () {
      const first = yield* begin
      const path = "chats/Bot/resumed-leaf.jsonl"
      const lines = Array.from({ length: 330 }, (_, i) => message(`leaf-${i}`, i))
      yield* answer(
        yield* sendFile(first.importId, path, jsonl({ chat_metadata: {} }, ...lines.slice(0, 150)), {
          card: "none",
          last: "0"
        })
      )
      assert.strictEqual(yield* leafText(chatOf(path)), "leaf-149")
      const second = yield* begin
      assert.strictEqual(
        (yield* sendStFile(second.importId, path, jsonl({ chat_metadata: {} }, ...lines), { card: "none" })).outcome,
        "added"
      )
      assert.strictEqual(yield* leafText(chatOf(path)), "leaf-329")
    })
  )

  it.effect("a message the user amended still matches when its import resumes, and on a re-import", () =>
    Effect.gen(function* () {
      const path = "chats/Bot/amended.jsonl"
      const lines = [message("am-greeting", 0), message("am-user", 1), message("am-reply", 2)]
      const first = yield* begin
      yield* answer(
        yield* sendFile(first.importId, path, jsonl({ chat_metadata: {} }, ...lines), { card: "none", last: "0" })
      )
      const user = yield* first.api.Whoami()
      const writer = yield* Writer
      const versionId = query("SELECT id FROM versions WHERE content = 'am-user'")[0]!.id as VersionId
      yield* writer.AmendVersion({ userId: user.id, versionId, content: "am-user edited", expectedRowVersion: 1 })
      const second = yield* begin
      yield* sendStFile(second.importId, path, jsonl({ chat_metadata: {} }, ...lines, message("am-next", 3)), {
        card: "none"
      })
      assert.deepStrictEqual(
        pathTo("am-next").map((row) => row.content),
        ["am-greeting", "am-user edited", "am-reply", "am-next"]
      )
      assert.strictEqual(present("am-user"), 0)
      // The second amend: its row version is one more than its amends.
      yield* writer.AmendVersion({
        userId: user.id,
        versionId,
        content: "am-user edited again",
        expectedRowVersion: 2
      })
      const third = yield* begin
      const tail = [...lines, message("am-next", 3), message("am-tail", 4)]
      yield* sendStFile(third.importId, path, jsonl({ chat_metadata: {} }, ...tail), { card: "none" })
      assert.deepStrictEqual(
        pathTo("am-tail").map((row) => row.content),
        ["am-greeting", "am-user edited again", "am-reply", "am-next", "am-tail"]
      )
      assert.strictEqual(present("am-user"), 0)
      assert.strictEqual(present("am-reply"), 1)
      assert.strictEqual(yield* leafText(chatOf(path)), "am-tail")
    })
  )

  it.effect("a message deleted after an earlier one was amended stays in the bin on a resume", () =>
    Effect.gen(function* () {
      const path = "chats/Bot/amended-binned.jsonl"
      const lines = [message("ab-greeting", 0), message("ab-user", 1), message("ab-binned", 2)]
      const first = yield* begin
      yield* answer(
        yield* sendFile(first.importId, path, jsonl({ chat_metadata: {} }, ...lines), { card: "none", last: "0" })
      )
      const user = yield* first.api.Whoami()
      const versionId = query("SELECT id FROM versions WHERE content = 'ab-user'")[0]!.id as VersionId
      yield* (yield* Writer).AmendVersion({
        userId: user.id,
        versionId,
        content: "ab-user edited",
        expectedRowVersion: 1
      })
      const slotId = query(
        "SELECT s.id FROM slots s JOIN versions v ON v.slot_id = s.id WHERE v.content = 'ab-binned'"
      )[0]!.id as SlotId
      yield* first.api.DeleteMessage({ slotId })
      const second = yield* begin
      yield* sendStFile(second.importId, path, jsonl({ chat_metadata: {} }, ...lines, message("ab-next", 3)), {
        card: "none"
      })
      const rows = query(
        "SELECT s.deleted_at FROM slots s JOIN versions v ON v.slot_id = s.id WHERE v.content = 'ab-binned'"
      )
      assert.lengthOf(rows, 1)
      assert.isNotNull(rows[0]!.deleted_at)
      assert.strictEqual(present("ab-user"), 0)
    })
  )

  for (const unfinished of [true, false]) {
    it.effect(
      `a branch's selected versions and deleted messages stay the user's on a ${unfinished ? "resume" : "re-import"}`,
      () =>
        Effect.gen(function* () {
          const tag = unfinished ? "bs-resume" : "bs-reimport"
          const root = `chats/Bot/${tag}-root.jsonl`
          const branch = `chats/Bot/${tag}-branch.jsonl`
          const base = [message(`${tag}-g`, 0), message(`${tag}-u`, 1)]
          const first = yield* begin
          yield* sendStFile(
            first.importId,
            root,
            jsonl({ chat_metadata: {} }, ...base, message(`${tag}-root-reply`, 2)),
            {
              card: "none"
            }
          )
          const lines = [
            ...base,
            message(`${tag}-reply`, 2, { swipes: [`${tag}-reply`, `${tag}-alt`], swipe_id: 0 }),
            message(`${tag}-bin`, 3)
          ]
          const header = { chat_metadata: { main_chat: `${tag}-root` } }
          if (unfinished) {
            yield* answer(yield* sendFile(first.importId, branch, jsonl(header, ...lines), { card: "none", last: "0" }))
          } else {
            yield* sendStFile(first.importId, branch, jsonl(header, ...lines), { card: "none" })
          }
          const user = yield* first.api.Whoami()
          const slot = query("SELECT slot_id FROM versions WHERE content = ?", `${tag}-reply`)[0]!.slot_id as SlotId
          const alt = query("SELECT id FROM versions WHERE content = ?", `${tag}-alt`)[0]!.id as VersionId
          const shown = shownAt(slot)
          yield* (yield* Writer).SelectVersion({
            userId: user.id,
            slotId: slot,
            versionId: alt,
            expectedVersionId: shown as VersionId
          })
          const binned = query("SELECT slot_id FROM versions WHERE content = ?", `${tag}-bin`)[0]!.slot_id as SlotId
          yield* first.api.DeleteMessage({ slotId: binned })
          const next = yield* begin
          yield* sendStFile(next.importId, branch, jsonl(header, ...lines, message(`${tag}-tail`, 4)), { card: "none" })
          assert.strictEqual(shownAt(slot), alt)
          assert.strictEqual(present(`${tag}-reply`), 1)
          const rows = query(
            "SELECT s.deleted_at FROM slots s JOIN versions v ON v.slot_id = s.id WHERE v.content = ?",
            `${tag}-bin`
          )
          assert.lengthOf(rows, 1)
          assert.isNotNull(rows[0]!.deleted_at)
        })
    )
  }

  it.effect("the staging folder of earlier versions goes at startup, but a link there isn't followed", () =>
    Effect.gen(function* () {
      const dataDir = tempDir("st-staging")
      mkdirSync(join(dataDir, "st-staging", "an-import"), { recursive: true })
      writeFileSync(join(dataDir, "st-staging", "an-import", "chat.jsonl"), "held")
      yield* removeOldStaging(dataDir)
      assert.isFalse(existsSync(join(dataDir, "st-staging")))

      const elsewhere = tempDir("st-staging-target")
      writeFileSync(join(elsewhere, "keep.txt"), "kept")
      symlinkSync(elsewhere, join(dataDir, "st-staging"))
      yield* removeOldStaging(dataDir)
      assert.strictEqual(readFileSync(join(elsewhere, "keep.txt"), "utf8"), "kept")
      assert.isTrue(lstatSync(join(dataDir, "st-staging")).isSymbolicLink())
    })
  )
})
