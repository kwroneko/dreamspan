// Synthetic chats for the performance harness (CLIENT-FRAMEWORK §7): one of 100,000
// messages and two of 300, generated, never derived from real chats (CLAUDE.md "Privacy").
//
// The schema comes from the server itself (it migrates a fresh data directory and creates
// the chats through RPC); the messages are then written straight into the file in one
// transaction, which takes seconds where 100,000 RPCs would take minutes. The result is
// cached by fixture version and copied for each run.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import { syntheticMarkdown } from "../../server/src/chat/syntheticText.ts"
import { startServer, withClient } from "./support.ts"

/** Bump when what's generated changes, so a stale cache isn't used. */
const VERSION = 1
const DB = "rp-harness.db"

export interface Fixture {
  readonly long: { readonly chatId: ChatId; readonly deep: SlotId }
  readonly short: ReadonlyArray<{ readonly chatId: ChatId; readonly title: string }>
}

/** How the long chat is shaped: every 25th reply has four versions, one of them failed. */
const versionsAt = (depth: number) => (depth % 50 === 1 ? 4 : 1)
const htmlAt = (depth: number) => depth % 997 === 0

const fill = (db: DatabaseSync, chatId: string, count: number, seed: number) => {
  const lane = (db.prepare("SELECT id FROM lanes WHERE chat_id = ?").get(chatId) as { id: string }).id
  const insertVersion = db.prepare(
    `INSERT INTO versions (id, slot_id, ordinal, status, writer, content, macro_mode, origin, error_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'verbatim', ?, ?, ?, ?)`
  )
  const insertSlot = db.prepare(
    `INSERT INTO slots (id, chat_id, lane_id, parent_slot_id, depth, selected_version_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const start = Date.now() - count * 60_000
  const slots: Array<string> = []
  let parent: string | null = null
  const message = (depth: number, parentId: string | null, branchSeed = 0) => {
    const at = start + depth * 60_000
    const slotId = uuidv7()
    const model = depth % 2 === 1
    const words = model ? 40 + ((depth * 7919 + branchSeed) % 220) : 8 + ((depth * 104729 + branchSeed) % 60)
    let selected = ""
    for (let ordinal = 0; ordinal < (model ? versionsAt(depth) : 1); ordinal++) {
      const id = uuidv7()
      const failed = ordinal === 1
      let content = syntheticMarkdown(seed + depth * 31 + ordinal + branchSeed, failed ? 20 : words)
      if (htmlAt(depth)) content = `<div class="status">HP <b>12</b> · Mood: wary</div>\n\n${content}`
      insertVersion.run(
        id,
        slotId,
        ordinal,
        failed ? "failed" : "complete",
        model ? "model" : "human",
        content,
        model ? "generated" : "user_written",
        failed ? JSON.stringify({ class: "network", message: "connection reset" }) : null,
        at,
        at
      )
      if (!failed) selected = id
    }
    insertSlot.run(slotId, chatId, lane, parentId, depth, selected, at)
    return slotId
  }
  for (let depth = 0; depth < count; depth++) {
    parent = message(depth, parent)
    slots.push(parent)
    // Now and then an older branch: three messages off the main path.
    if (depth % 5000 === 2500) {
      let side = parent
      for (let i = 1; i <= 3; i++) side = message(depth + i, side, 7)
    }
  }
  db.prepare(
    "UPDATE chats SET active_leaf_slot_id = ?, last_message_at = ?, row_version = row_version + 1 WHERE id = ?"
  ).run(parent, Date.now(), chatId)
  return slots
}

const build = async (dir: string): Promise<Fixture> => {
  const server = await startServer(dir)
  const [long, a, b] = await withClient(server, (api) =>
    Effect.all([
      api.CreateChat({ title: "The long voyage" }),
      api.CreateChat({ title: "Harbor watch" }),
      api.CreateChat({ title: "Tide caves" })
    ])
  )
  await server.stop()

  const db = new DatabaseSync(join(dir, DB))
  db.exec("PRAGMA synchronous = OFF")
  db.exec("BEGIN")
  const longSlots = fill(db, long.id, 100_000, 1)
  fill(db, a.id, 300, 2)
  fill(db, b.id, 300, 3)
  db.exec("COMMIT")
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  db.close()
  return {
    long: { chatId: long.id, deep: longSlots[30_000]! as SlotId },
    short: [
      { chatId: a.id, title: a.title },
      { chatId: b.id, title: b.title }
    ]
  }
}

/** A fresh data directory holding the fixtures, built once per fixture version. The caller removes it. */
export const prepare = async (): Promise<{ dataDir: string; fixture: Fixture }> => {
  // Outside the run's own temp directory (globalSetup.ts), so it outlives the run.
  const cache = join(process.env.RP_PERF_CACHE_ROOT ?? tmpdir(), `rp-perf-fixture-v${VERSION}`)
  if (!existsSync(join(cache, "fixture.json"))) {
    const building = mkdtempSync(join(tmpdir(), "rp-perf-build-"))
    try {
      const fixture = await build(building)
      writeFileSync(join(building, "fixture.json"), JSON.stringify(fixture))
      rmSync(cache, { recursive: true, force: true })
      mkdirSync(cache, { recursive: true })
      for (const file of [DB, "fixture.json"]) renameSync(join(building, file), join(cache, file))
    } finally {
      rmSync(building, { recursive: true, force: true })
    }
  }
  const dataDir = mkdtempSync(join(tmpdir(), "rp-perf-"))
  copyFileSync(join(cache, DB), join(dataDir, DB))
  return { dataDir, fixture: JSON.parse(readFileSync(join(cache, "fixture.json"), "utf8")) as Fixture }
}
