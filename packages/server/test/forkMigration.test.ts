// Migration 0053 (spec/FORK-INDEPENDENCE-DELTA.md §5, implementation unit 2): a fork per line
// of each chat, on a realistic synthetic import plus a graph built with the writer, then
// taken back to before forks (support/unmigrateForks.ts) and migrated again. Nothing a user
// sees may change: every table keeps its rows, every line the switcher reaches is one fork
// whose path ends at its leaf, the chat opens where it did, and the names, the switcher's
// labels and the composers stay where they were. Also: a 100,000-message chat with 200
// branch points migrates in one pass, and a slot outside its chat's lanes stops it.
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { type ChatId, type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { Generator } from "../src/chat/Generator.ts"
import { databaseFile, writerConnection } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { migrations } from "../src/db/migrations.ts"
import { pathWindow } from "../src/db/reads.ts"
import { client, serverLayer, testConfig, typeInto } from "./support/config.ts"
import { docFor } from "./support/docs.ts"
import { writeRealisticStFolder } from "./support/stRealistic.ts"
import { importStFolder } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"
import { unmigrateForks } from "./support/unmigrateForks.ts"

const say = (speaker: EntityId, content: string, writer: "human" | "model" = "human") =>
  new NewVersion({
    speakerEntityId: speaker,
    writer,
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: writer === "human" ? "user_written" : "generated"
  })

const plain = (rows: ReadonlyArray<unknown>) => JSON.parse(JSON.stringify(rows)) as Array<Record<string, unknown>>

/**
 * Every table's rows as they were before 0053, in the columns they had then, except what
 * the migration moves: a branch's name to its fork, a composer draft's key to its fork.
 */
const contents = (db: DatabaseSync, tables: ReadonlyArray<{ name: string; columns: ReadonlyArray<string> }>) =>
  Object.fromEntries(
    tables.map(({ name, columns }) => {
      const kept = columns.filter(
        (c) => !(name === "slots" && c === "branch_name") && !(name === "drafts" && c === "field")
      )
      return [name, plain(db.prepare(`SELECT ${kept.join(", ")} FROM ${name} ORDER BY rowid`).all())]
    })
  )

const tablesOf = (db: DatabaseSync) =>
  (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE '%_fts%' AND name <> 'effect_sql_migrations' AND sql NOT LIKE 'CREATE VIRTUAL%'
          AND sql NOT LIKE '%WITHOUT ROWID%' ORDER BY name`
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => ({
    name,
    columns: (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(name) as Array<{ name: string }>).map(
      (c) => c.name
    )
  }))

interface Slot {
  readonly id: string
  readonly chat_id: string
  readonly parent_slot_id: string | null
  readonly deleted_at: number | null
  readonly branch_deleted: number
}

/**
 * The leaves of every chat as paths reached them before forks, worked out here apart from
 * the migration: from each root down, through live messages and through messages deleted
 * on their own that still have a live reply below them, never into a deleted branch.
 */
const leavesBefore = (db: DatabaseSync) => {
  const slots = db.prepare("SELECT id, chat_id, parent_slot_id, deleted_at, branch_deleted FROM slots").all() as Array<
    Slot & Record<string, unknown>
  >
  const children = new Map<string | null, Array<Slot>>()
  for (const slot of slots) {
    const key = slot.parent_slot_id === null ? `root:${slot.chat_id}` : slot.parent_slot_id
    children.set(key, [...(children.get(key) ?? []), slot])
  }
  const kids = (slot: Slot) => children.get(slot.id) ?? []
  const liveBelow = (slot: Slot): boolean =>
    kids(slot).some((c) => c.deleted_at === null || (c.branch_deleted === 0 && liveBelow(c)))
  const reachable = (slot: Slot) => slot.deleted_at === null || (slot.branch_deleted === 0 && liveBelow(slot))
  const leaves: Array<string> = []
  const walk = (slot: Slot) => {
    const next = kids(slot).filter(reachable)
    if (next.length === 0) leaves.push(slot.id)
    for (const child of next) walk(child)
  }
  for (const chat of new Set(slots.map((s) => s.chat_id)))
    for (const root of (children.get(`root:${chat}`) ?? []).filter(reachable)) walk(root)
  return leaves.sort()
}

describe("0053_forks", () => {
  it.live(
    "makes a fork per line of a realistic graph, and nothing a user sees changes",
    () => {
      const dataDir = tempDir("forks-migration")
      return Effect.gen(function* () {
        const built = yield* Effect.gen(function* () {
          const root = tempDir("st-forks")
          writeRealisticStFolder(root)
          const files = new Map(
            readdirSync(root, { recursive: true, withFileTypes: true })
              .filter((entry) => entry.isFile())
              .map((entry) => {
                const path = join(entry.parentPath, entry.name)
                return [relative(root, path), new Uint8Array(readFileSync(path))] as const
              })
          )
          yield* importStFolder(files)

          const api = yield* client()
          const writer = yield* Database.Writer
          const userId = (yield* api.Whoami()).id as UserId
          const { entityId: mira } = yield* writer.CreateEntity({
            userId,
            kind: "card",
            label: "Mira",
            subtitle: "",
            doc: docFor("card", "Mira"),
            schemaVersion: 1,
            origin: "user",
            sourcePath: null
          })
          const chat = yield* writer.CreateChat({
            userId,
            kind: "rp",
            status: "active",
            title: "Harbor",
            participants: [mira],
            greeting: new NewVersion({ ...say(mira, "The bell rings."), origin: "greeting" })
          })
          let n = 0
          const append = (parentSlotId: SlotId | null, branch = false) =>
            writer.AppendMessage({
              userId,
              chatId: chat.id,
              parentSlotId,
              branch,
              version: say(mira, `message ${n++}`, n % 2 ? "model" : "human"),
              commitDraft: null
            })
          const line = (from: SlotId | null, count: number) =>
            Effect.gen(function* () {
              const slots: Array<SlotId> = from === null ? [] : [from]
              let fork: ForkId | null = null
              for (let i = 0; i < count; i++) {
                const sent = yield* append(slots.at(-1) ?? null, true)
                slots.push(sent.slotId)
                fork = sent.forkId
              }
              return { slots, fork: fork! }
            })
          const state = (slotId: SlotId | null, name: string, versionId: string | null = null) =>
            writer.AddStateEvent({
              userId,
              chatId: chat.id,
              slotId,
              versionId: versionId as never,
              scope: null,
              data: { key: "var.set", value: { name, value: name } }
            })
          const main = yield* line(chat.activeLeafSlotId!, 30)
          const rootBranch = yield* line(null, 5)
          const mid = yield* line(main.slots[10]!, 12)
          const nested = yield* line(mid.slots[4]!, 6)
          yield* line(nested.slots[2]!, 3)
          const doomed = yield* line(main.slots[20]!, 4)
          const purged = yield* line(main.slots[25]!, 4)
          yield* state(null, "chatwide")
          yield* state(main.slots[5]!, "shared")
          yield* state(mid.slots[6]!, "mid-only")
          // Swipes: one selected and attached to an event, one deleted.
          const swipe = yield* writer.AddVersion({
            userId,
            slotId: main.slots[15]!,
            version: say(mira, "swiped", "model"),
            select: true,
            commitDraft: null
          })
          yield* state(main.slots[15]!, "on-swipe", swipe.id)
          const gone = yield* writer.AddVersion({
            userId,
            slotId: main.slots[16]!,
            version: say(mira, "gone", "model"),
            select: false,
            commitDraft: null
          })
          yield* writer.DeleteVersion({ userId, versionId: gone.id })
          yield* writer.DeleteMessage({ userId, slotId: main.slots[12]! })
          // A message deleted at the end of a line, which takes the fork's tip up with it.
          yield* writer.DeleteMessage({ userId, slotId: nested.slots.at(-1)! })
          // Typed in a branch, then the branch went to the bin.
          yield* typeInto(api, chat.id, doomed.fork, "Typed before the branch went")
          yield* writer.DeleteBranch({ userId, slotId: doomed.slots[1]! })
          const item = yield* writer.DeleteBranch({ userId, slotId: purged.slots[1]! })
          yield* writer.PurgeBinItem({ userId, itemId: item.id })
          for (const slotId of main.slots.slice(7, 10)) yield* writer.SetSlotHidden({ userId, slotId, hidden: true })
          // Names: the forks that start at the root and mid-path.
          yield* api.NameFork({ forkId: rootBranch.fork, name: "From the top" })
          yield* api.NameFork({ forkId: mid.fork, name: "The middle road" })
          // Composers: the main line's, and an empty chat's.
          yield* typeInto(api, chat.id, main.fork, "Half a thought on the main line")
          const empty = yield* api.CreateChat({ title: "Nothing yet" })
          yield* typeInto(api, empty.id, null, "A first line, unsent")
          return { chatId: chat.id, emptyId: empty.id, main, mid }
        }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ dataDir }), Generator.none)))

        // The database as the code before forks left it, with what only it could write: a
        // name on a slot that continues its parent's chain, and the chat's active leaf
        // above live messages (SetActiveLeaf).
        const db = new DatabaseSync(databaseFile(dataDir))
        unmigrateForks(db)
        const continuation = built.main.slots[11]!
        db.prepare("UPDATE slots SET branch_name = 'Branch 1, renamed', branch_name_user = 1 WHERE id = ?").run(
          continuation
        )
        const interior = built.main.slots[18]!
        db.prepare("UPDATE chats SET active_leaf_slot_id = ? WHERE id = ?").run(interior, built.chatId)
        const tables = tablesOf(db)
        const before = contents(db, tables)
        const leaves = leavesBefore(db)
        const labels = new Map(
          (
            db.prepare("SELECT id, branch_name FROM slots").all() as Array<{ id: string; branch_name: string | null }>
          ).map((r) => [r.id, r.branch_name])
        )
        const active = db.prepare("SELECT id, active_leaf_slot_id AS leaf FROM chats ORDER BY id").all() as Array<{
          id: ChatId
          leaf: SlotId | null
        }>
        const composers = db
          .prepare("SELECT id, target_id, field, content FROM drafts WHERE target_kind = 'composer' ORDER BY id")
          .all() as Array<{ id: string; target_id: string; field: string; content: string }>
        assert.isAbove(leaves.length, 20, "the fixture should branch a lot")
        assert.isAbove(composers.length, 2)
        db.close()

        yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(
          Effect.provide(writerConnection(databaseFile(dataDir)))
        )

        const after = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
        try {
          // Nothing but structure was written.
          assert.deepStrictEqual(contents(after, tables), before)
          assert.deepStrictEqual(
            plain(after.prepare("SELECT id, active_leaf_slot_id AS leaf FROM chats ORDER BY id").all()),
            plain(active)
          )
          const forks = after.prepare("SELECT * FROM forks").all() as Array<{
            id: ForkId
            chat_id: ChatId
            parent_fork_id: ForkId | null
            base_slot_id: SlotId | null
            tip_slot_id: SlotId | null
            name: string | null
            deleted_at: number | null
            bin_item_id: string | null
            purged_at: number | null
          }>
          const live = forks.filter((f) => f.deleted_at === null)
          // Every leaf a path reached is the tip of exactly one live fork.
          for (const leaf of leaves)
            assert.lengthOf(
              live.filter((f) => f.tip_slot_id === leaf),
              1,
              leaf
            )
          // Every other live fork is the opened chat's checkpoint, or an empty chat's.
          const extra = live.filter((f) => f.tip_slot_id === null || !leaves.includes(f.tip_slot_id))
          assert.sameDeepMembers(
            extra.map((f) => [f.chat_id, f.tip_slot_id, f.base_slot_id]),
            [
              [built.chatId, interior, interior],
              [built.emptyId, null, null]
            ]
          )
          // The chat opens where it did, on a fork whose tip is its active leaf.
          for (const chat of active) {
            const current = after.prepare("SELECT current_fork_id AS id FROM chats WHERE id = ?").get(chat.id) as {
              id: ForkId
            }
            const fork = forks.find((f) => f.id === current.id)!
            assert.strictEqual(fork.tip_slot_id, chat.leaf, chat.id)
            assert.isNull(fork.deleted_at)
          }
          // Each chat's first fork, the line through its first root, has the chat's id.
          for (const chat of active)
            assert.isDefined(
              forks.find((f) => f.id === (chat.id as string)),
              chat.id
            )
          // Parents form no cycle, and a parent is always in the same chat.
          const byId = new Map(forks.map((f) => [f.id, f]))
          for (const fork of forks) {
            const seen = new Set<string>()
            for (let up: (typeof forks)[number] | undefined = fork; up;) {
              assert.isFalse(seen.has(up.id), `a cycle through ${fork.id}`)
              seen.add(up.id)
              assert.strictEqual(up.chat_id, fork.chat_id)
              up = up.parent_fork_id === null ? undefined : byId.get(up.parent_fork_id)
            }
          }
          // The deleted branch's line is a fork in the bin under its item; the purged one's
          // keeps its row without a tip.
          const binned = forks.filter((f) => f.deleted_at !== null)
          assert.isTrue(binned.some((f) => f.bin_item_id !== null && f.purged_at === null && f.tip_slot_id !== null))
          assert.isTrue(binned.some((f) => f.purged_at !== null && f.tip_slot_id === null && f.bin_item_id === null))
          // Names went to the forks that start at those slots; the continuation's stayed.
          assert.sameMembers(
            forks.flatMap((f) => (f.name === null ? [] : [f.name])),
            ["From the top", "The middle road"]
          )
          assert.strictEqual(
            (after.prepare("SELECT branch_name FROM slots WHERE id = ?").get(continuation) as { branch_name: string })
              .branch_name,
            "Branch 1, renamed"
          )
          // Composers are keyed by the fork that ends where they were; one typed before the
          // first message by the chat's fork.
          for (const draft of composers) {
            const field = (after.prepare("SELECT field FROM drafts WHERE id = ?").get(draft.id) as { field: string })
              .field
            const fork = byId.get(field as ForkId)!
            assert.strictEqual(fork.chat_id, draft.target_id, draft.content)
            assert.strictEqual(fork.tip_slot_id ?? "", draft.field, draft.content)
          }
          assert.deepStrictEqual(after.prepare("SELECT * FROM recovered_texts").all(), [])

          // Each fork's path, read as the client reads it, is the path to its leaf, with the
          // labels every slot had among its alternates.
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            for (const fork of live) {
              if (fork.tip_slot_id === null) continue
              const rows = yield* pathWindow(sql, fork.chat_id, fork.tip_slot_id, 1000)
              assert.strictEqual(rows.at(-1)!.slot_id, fork.tip_slot_id)
              for (const row of rows)
                assert.strictEqual(row.branch_name, labels.get(row.slot_id) ?? null, `${row.slot_id} on ${fork.id}`)
            }
          }).pipe(Effect.provide(SqliteClient.layer({ filename: databaseFile(dataDir), readonly: true })))
        } finally {
          after.close()
        }
      })
    },
    180_000
  )

  it.live(
    "migrates a 100,000-message chat with 200 branch points, a fork per line",
    () => {
      const dataDir = tempDir("forks-scale")
      return Effect.gen(function* () {
        yield* SqliteMigrator.run({
          loader: SqliteMigrator.fromRecord(Object.fromEntries(Object.entries(migrations).filter(([k]) => k < "0053")))
        }).pipe(Effect.provide(writerConnection(databaseFile(dataDir))))
        const db = new DatabaseSync(databaseFile(dataDir))
        const length = 100_000
        const branches = new Set(Array.from({ length: 200 }, (_, i) => 5 * (i + 1)))
        try {
          db.exec(`PRAGMA foreign_keys = ON; BEGIN;
            INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'u', 'admin', 1);
            INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES ('chat', 'u', 'rp', 'active', 1);
            INSERT INTO lanes (id, chat_id, name, created_at) VALUES ('lane', 'chat', 'main', 1);`)
          const version = db.prepare(`INSERT INTO versions
            (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at)
            VALUES (?, ?, 0, 'complete', 'model', 'Synthetic', 'verbatim', 'generated', 1, 1)`)
          const slot = db.prepare(`INSERT INTO slots
            (id, chat_id, lane_id, parent_slot_id, depth, selected_version_id, created_at)
            VALUES (?, 'chat', 'lane', ?, ?, ?, 1)`)
          const add = (id: string, parent: string | null, depth: number) => {
            version.run(`v-${id}`, id)
            slot.run(id, parent, depth, `v-${id}`)
          }
          for (let depth = 0; depth <= length; depth++) {
            const parent = depth === 0 ? null : `p-${depth - 1}`
            // The side reply first, so the path's child starts a chain at each branch point.
            if (branches.has(depth)) add(`side-${depth}`, parent, depth)
            add(`p-${depth}`, parent, depth)
          }
          db.prepare("UPDATE chats SET active_leaf_slot_id = ? WHERE id = 'chat'").run(`p-${length}`)
          db.exec("COMMIT")
        } finally {
          db.close()
        }
        yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(
          Effect.provide(writerConnection(databaseFile(dataDir)))
        )
        const after = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
        try {
          const forks = after.prepare("SELECT * FROM forks ORDER BY id").all() as Array<{
            id: string
            parent_fork_id: string | null
            base_slot_id: string | null
            tip_slot_id: string
          }>
          // The path's line, and one per side reply.
          assert.lengthOf(forks, 201)
          const main = forks.find((f) => f.tip_slot_id === `p-${length}`)!
          assert.strictEqual(
            (after.prepare("SELECT current_fork_id AS id FROM chats").get() as { id: string }).id,
            main.id
          )
          // The path took a later child at every branch point: each side reply ends the line
          // the path's chain above it started, which diverged from the line before.
          const side = forks.find((f) => f.tip_slot_id === "side-500")!
          assert.strictEqual(side.base_slot_id, "p-494")
          assert.strictEqual(forks.find((f) => f.id === side.parent_fork_id)?.tip_slot_id, "side-495")
          // The first root's line is the chat's first fork.
          assert.deepStrictEqual(
            forks.filter((f) => f.parent_fork_id === null).map((f) => [f.id, f.tip_slot_id]),
            [["chat", "side-5"]]
          )
          assert.strictEqual(main.base_slot_id, "p-999")
          assert.strictEqual(forks.find((f) => f.id === main.parent_fork_id)?.tip_slot_id, "side-1000")
          // Every slot of the last segment was the main line's own.
          const own = after.prepare("SELECT count(*) AS n FROM slots WHERE fork_id = ?").get(main.id) as { n: number }
          assert.strictEqual(own.n, length - 1000 + 1)
        } finally {
          after.close()
        }
      })
    },
    600_000
  )
})
