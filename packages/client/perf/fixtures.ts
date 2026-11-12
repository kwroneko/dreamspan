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
import { syntheticMarkdown } from "../../server/src/dev/syntheticText.ts"
import { startServer, withClient } from "./support.ts"

/** Bump when what's generated changes, so a stale cache isn't used. */
const VERSION = 4
const DB = "rp-harness.db"

export interface Fixture {
  readonly long: { readonly chatId: ChatId; readonly deep: SlotId }
  /** 20,000 messages, the first 18,000 under summaries up to level 4; the divider is at `boundary`. */
  readonly summarized: { readonly chatId: ChatId; readonly boundary: SlotId; readonly covered: SlotId }
  readonly short: ReadonlyArray<{ readonly chatId: ChatId; readonly title: string }>
}

/** How the long chat is shaped: every 25th reply has four versions, one of them failed. */
const versionsAt = (depth: number) => (depth % 50 === 1 ? 4 : 1)
const htmlAt = (depth: number) => depth % 997 === 0

const fill = (db: DatabaseSync, chatId: string, count: number, seed: number) => {
  const insertVersion = db.prepare(
    `INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, error_json, created_at, updated_at, authoring_fork_id)
     VALUES (?, ?, ?, ?, ?, ?, 'verbatim', ?, ?, ?, ?, ?)`
  )
  const insertSlot = db.prepare(
    `INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const start = Date.now() - count * 60_000
  const slots: Array<string> = []
  /** The version each slot on the main path shows. */
  const versions: Array<string> = []
  let parent: string | null = null
  let lastSelected = ""
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
        at,
        chatId
      )
      if (!failed) selected = id
    }
    insertSlot.run(slotId, chatId, parentId, depth, selected, at)
    lastSelected = selected
    return slotId
  }
  for (let depth = 0; depth < count; depth++) {
    parent = message(depth, parent)
    slots.push(parent)
    versions.push(lastSelected)
    // Now and then an older branch: three messages off the main path.
    if (depth % 5000 === 2500) {
      let side = parent
      for (let i = 1; i <= 3; i++) side = message(depth + i, side, 7)
    }
  }
  db.prepare(
    "UPDATE chats SET active_leaf_slot_id = ?, last_message_at = ?, row_version = row_version + 1 WHERE id = ?"
  ).run(parent, Date.now(), chatId)
  return { slots, versions }
}

/**
 * Summaries over the first `covered` messages as the summarizer would leave them: level 1
 * over 16 messages each, and four levels of fives above, so the layer is the nine of level 4.
 */
const summarize = (
  db: DatabaseSync,
  chatId: string,
  path: { slots: Array<string>; versions: Array<string> },
  covered: number
) => {
  const revision = db.prepare(
    "INSERT INTO summary_revisions (id, summary_id, content, token_count, origin, created_at) VALUES (?, ?, ?, ?, 'generated', ?)"
  )
  const summary = db.prepare(
    `INSERT INTO summaries (id, chat_id, level, selected_revision_id, first_slot_id, last_slot_id, slot_count, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?)`
  )
  const input = db.prepare(
    "INSERT INTO summary_inputs (summary_id, ordinal, slot_id, version_id, amend_count) VALUES (?, ?, ?, ?, 0)"
  )
  const parent = db.prepare(
    "INSERT INTO summary_parents (summary_id, ordinal, parent_id, parent_revision_id) VALUES (?, ?, ?, ?)"
  )
  const seal = db.prepare("UPDATE summaries SET sealed = 1 WHERE id = ?")
  interface Made {
    id: string
    revision: string
    first: string
    last: string
    count: number
  }
  const make = (level: number, first: string, last: string, count: number, text: string): Made => {
    const id = uuidv7()
    const revisionId = uuidv7()
    const now = Date.now()
    revision.run(revisionId, id, text, Math.ceil(text.length / 4), now)
    summary.run(id, chatId, level, revisionId, first, last, count, now)
    return { id, revision: revisionId, first, last, count }
  }
  let level: Array<Made> = []
  for (let at = 0; at + 16 <= covered; at += 16) {
    const made = make(1, path.slots[at]!, path.slots[at + 15]!, 16, syntheticMarkdown(at, 90))
    for (let i = 0; i < 16; i++) input.run(made.id, i, path.slots[at + i]!, path.versions[at + i]!)
    seal.run(made.id)
    level.push(made)
  }
  for (let depth = 2; depth <= 4; depth++) {
    const next: Array<Made> = []
    for (let at = 0; at + 5 <= level.length; at += 5) {
      const group = level.slice(at, at + 5)
      const made = make(
        depth,
        group[0]!.first,
        group[4]!.last,
        group.reduce((n, g) => n + g.count, 0),
        syntheticMarkdown(at + depth, 120)
      )
      group.forEach((child, i) => parent.run(made.id, i, child.id, child.revision))
      seal.run(made.id)
      next.push(made)
    }
    level = next
  }
}

const build = async (dir: string): Promise<Fixture> => {
  const server = await startServer(dir)
  const [long, a, b, summarized] = await withClient(server, (api) =>
    Effect.gen(function* () {
      // No spending ahead: the summarized chat has more raw messages than its window, and on
      // start the summarizer would plan them all, holding the writer for half a minute and
      // failing for want of a model, which is not what these scenarios measure.
      yield* api.SetGenerationDefaults({ defaults: { model: null, preset: null, lcm: { spendAhead: false } } })
      return yield* Effect.all([
        api.CreateChat({ title: "The long voyage" }),
        api.CreateChat({ title: "Harbor watch" }),
        api.CreateChat({ title: "Tide caves" }),
        api.CreateChat({ title: "The summarized voyage" })
      ])
    })
  )
  await server.stop()

  const db = new DatabaseSync(join(dir, DB))
  db.exec("PRAGMA synchronous = OFF")
  db.exec("BEGIN")
  const { slots: longSlots } = fill(db, long.id, 100_000, 1)
  fill(db, a.id, 300, 2)
  fill(db, b.id, 300, 3)
  // These chats stand for imported ones, where LCM is off (DESIGN §8.1). With it on, the first
  // reply would plan a backfill of the whole 100,000 messages in one transaction, which is the
  // enable flow's job (LCM slice 6), not what these scenarios measure.
  for (const chatId of [long.id, a.id, b.id]) {
    db.prepare(
      `INSERT INTO state_events (id, chat_id, seq, key, value_json, origin, created_at)
       SELECT ?, ?, coalesce(max(seq), 0) + 1, 'lcm.settings', '{"enabled":false}', 'user', ? FROM state_events
       WHERE chat_id = ? AND slot_id IS NULL`
    ).run(uuidv7(), chatId, Date.now(), chatId)
  }
  const voyage = fill(db, summarized.id, 20_000, 4)
  // 18,000 = 1,125 summaries of 16 messages, in nine whole groups of 125.
  summarize(db, summarized.id, voyage, 18_000)
  db.exec("COMMIT")
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  db.close()
  return {
    long: { chatId: long.id, deep: longSlots[30_000]! as SlotId },
    summarized: {
      chatId: summarized.id,
      boundary: voyage.slots[18_000]! as SlotId,
      covered: voyage.slots[17_999]! as SlotId
    },
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
