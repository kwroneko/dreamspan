// Chains (spec/FORK-INDEPENDENCE-DELTA.md §2.1, implementation unit 1): how the database
// assigns them, the triggers that keep them, the segments a path is read by, and migration
// 0052 on realistic data, checked against the path and state-event reads it replaced.
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { type ChatId, type EntityId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { Generator } from "../src/chat/Generator.ts"
import { databaseFile, writerConnection } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { migrations } from "../src/db/migrations.ts"
import { pathSegments } from "../src/db/pathSegments.ts"
import { pathColumns, pathWindow, stateEventsOnPath } from "../src/db/reads.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
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

/** A user with a card and a chat greeted by it, and appends through the real writer. */
const setup = Effect.gen(function* () {
  const writer = yield* Database.Writer
  const user = yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })
  const userId = user.id as UserId
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
    writer
      .AppendMessage({
        userId,
        chatId: chat.id,
        parentSlotId,
        branch,
        version: say(mira, `message ${n++}`, n % 2 ? "model" : "human"),
        commitDraft: null
      })
      .pipe(Effect.map((sent) => sent.slotId))
  return { writer, userId, mira, chat, root: chat.activeLeafSlotId!, append }
})

const chainOf = (db: DatabaseSync, id: string) =>
  (db.prepare("SELECT chain_id FROM slots WHERE id = ?").get(id) as { chain_id: string }).chain_id

const readOnly = (dataDir: string) => SqliteClient.layer({ filename: databaseFile(dataDir), readonly: true })

describe("chains", () => {
  it.live("a first child continues its parent's chain; a later child and a root start their own", () => {
    const dataDir = tempDir("chains")
    return Effect.gen(function* () {
      const s = yield* Effect.gen(function* () {
        const { chat, root, append } = yield* setup
        const a = yield* append(root)
        const b = yield* append(a)
        const c = yield* append(a, true) // a's second child
        const d = yield* append(c)
        const e = yield* append(c, true) // c's second child
        const f = yield* append(b, true) // b's first child, appended as a branch
        const root2 = yield* append(null, true)
        const g = yield* append(root2)
        return { chatId: chat.id, root, a, b, c, d, e, f, root2, g }
      }).pipe(Effect.provide(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, workers: "source" })))

      const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
      const chains = Object.fromEntries(
        (["root", "a", "b", "c", "d", "e", "f", "root2", "g"] as const).map((k) => [k, chainOf(db, s[k])])
      )
      db.close()
      assert.deepStrictEqual(chains, {
        root: s.root,
        a: s.root,
        b: s.root,
        c: s.c,
        d: s.c,
        e: s.e,
        f: s.root,
        root2: s.root2,
        g: s.root2
      })

      // A path's segments, newest first: d's path is c's chain from depth 2, then the root's.
      const segments = (slotId: SlotId, limit: number | null) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{ chain_id: string; lo: number; hi: number }>`
            ${pathSegments(sql, s.chatId, slotId, limit)} SELECT chain_id, lo, hi FROM segments`
        }).pipe(Effect.provide(readOnly(dataDir)))
      assert.deepStrictEqual(yield* segments(s.d, null), [
        { chain_id: s.c, lo: 2, hi: 3 },
        { chain_id: s.root, lo: 0, hi: 1 }
      ])
      assert.deepStrictEqual(yield* segments(s.e, null), [
        { chain_id: s.e, lo: 3, hi: 3 },
        { chain_id: s.c, lo: 2, hi: 2 },
        { chain_id: s.root, lo: 0, hi: 1 }
      ])
      // A window stops at the first segment reaching its oldest depth.
      assert.deepStrictEqual(yield* segments(s.d, 2), [{ chain_id: s.c, lo: 2, hi: 3 }])
      // A slot of another chat has no path in this one.
      const otherChat = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql`${pathSegments(sql, "elsewhere" as ChatId, s.d, null)} SELECT * FROM segments`
      }).pipe(Effect.provide(readOnly(dataDir)))
      assert.deepStrictEqual(otherChat, [])
    })
  })

  it.effect("are assigned by the database and never change, and state events carry them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'u', 'admin', 1)`
      yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES ('chat', 'u', 'rp', 'active', 1)`
      yield* sql`INSERT INTO lanes (id, chat_id, name, created_at) VALUES ('main', 'chat', 'main', 1), ('side', 'chat', 'side', 2)`
      const slot = (id: string, parent: string | null, depth: number, lane = "main", chain: string | null = null) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO versions (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at)
            VALUES (${`v-${id}`}, ${id}, 0, 'complete', 'human', 'x', 'verbatim', 'user_written', 1, 1)`
          yield* sql`INSERT INTO slots (id, chat_id, lane_id, parent_slot_id, depth, selected_version_id, created_at, chain_id)
            VALUES (${id}, 'chat', ${lane}, ${parent}, ${depth}, ${`v-${id}`}, 1, ${chain})`
        }).pipe(sql.withTransaction)
      const chain = (id: string) =>
        sql<{ chain_id: string }>`SELECT chain_id FROM slots WHERE id = ${id}`.pipe(Effect.map(([r]) => r!.chain_id))
      const refused = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.exit, Effect.map(Exit.isFailure))

      yield* slot("r", null, 0)
      yield* slot("a", "r", 1)
      yield* slot("b", "r", 1)
      // A child in another lane than its parent starts a chain, even as the first child.
      yield* slot("l", "a", 2, "side")
      yield* slot("m", "a", 2)
      assert.deepStrictEqual(
        [yield* chain("r"), yield* chain("a"), yield* chain("b"), yield* chain("l"), yield* chain("m")],
        ["r", "r", "b", "l", "r"]
      )
      // Nothing moves a slot to another chain, or inserts one with a chain other than its own.
      assert.isTrue(yield* refused(sql`UPDATE slots SET chain_id = 'b' WHERE id = 'a'`))
      assert.isTrue(yield* refused(slot("x", "b", 2, "main", "r")))
      assert.isTrue(yield* refused(slot("y", "m", 3, "main", "y")))
      yield* slot("z", "m", 3, "main", "r") // its own chain, stated
      assert.strictEqual(yield* chain("z"), "r")

      const event = (id: string, slotId: string | null, extra = sql``) =>
        sql`INSERT INTO state_events (id, chat_id, slot_id, seq, key, value_json, origin, created_at ${extra})
          VALUES (${id}, 'chat', ${slotId}, 0, 'var.set', '{}', 'user', 1)`
      yield* event("e1", "m")
      yield* event("e2", null)
      const placed = yield* sql<{ id: string; slot_chain_id: string | null; slot_depth: number | null }>`
        SELECT id, slot_chain_id, slot_depth FROM state_events ORDER BY id`
      assert.deepStrictEqual(placed, [
        { id: "e1", slot_chain_id: "r", slot_depth: 2 },
        { id: "e2", slot_chain_id: null, slot_depth: null }
      ])
      assert.isTrue(yield* refused(sql`UPDATE state_events SET slot_chain_id = 'b' WHERE id = 'e1'`))
      assert.isTrue(yield* refused(sql`UPDATE state_events SET slot_depth = 1 WHERE id = 'e1'`))
      assert.isTrue(
        yield* refused(sql`INSERT INTO state_events (id, chat_id, slot_id, seq, key, value_json, origin, created_at, slot_chain_id)
          VALUES ('e3', 'chat', NULL, 1, 'var.set', '{}', 'user', 1, 'r')`)
      )
    }).pipe(Effect.provide(writerConnection(join(tempDir("chains"), "db.sqlite"))))
  )
})

/** The window read before chains: a walk up parent links (reads.ts before 0052). */
const pathBefore = (db: DatabaseSync, chatId: string, leaf: string, limit: number) =>
  db
    .prepare(
      `WITH RECURSIVE path(id, n) AS (
        SELECT id, 1 FROM slots WHERE id = ? AND chat_id = ?
        UNION ALL
        SELECT s.parent_slot_id, p.n + 1 FROM slots s JOIN path p ON s.id = p.id
        WHERE s.parent_slot_id IS NOT NULL AND p.n < ?
      )
      SELECT ${pathColumns}
      FROM path JOIN slots s ON s.id = path.id LEFT JOIN fork_overrides so ON 0
        JOIN versions o ON o.id = s.selected_version_id JOIN versions v ON v.id = o.id
        LEFT JOIN fork_overrides ro ON 0 LEFT JOIN fork_overrides sf ON 0 LEFT JOIN fork_overrides pf ON 0
      ORDER BY s.depth`
    )
    .all(leaf, chatId, limit)

/** StateEventsAt's query before chains, over the whole path to the root. */
const eventsBefore = (db: DatabaseSync, chatId: string, slotId: string) =>
  db
    .prepare(
      `WITH RECURSIVE path(id, n) AS (
        SELECT id, 1 FROM slots WHERE id = ? AND chat_id = ?
        UNION ALL
        SELECT s.parent_slot_id, p.n + 1 FROM slots s JOIN path p ON s.id = p.id WHERE s.parent_slot_id IS NOT NULL
      )
      SELECT e.key, e.scope, e.value_json
      FROM state_events e
      LEFT JOIN path p ON p.id = e.slot_id
      LEFT JOIN slots s ON s.id = p.id
      WHERE e.chat_id = ? AND e.superseded_by_changeset IS NULL
        AND (e.slot_id IS NULL OR (p.id IS NOT NULL AND s.deleted_at IS NULL))
        AND (e.version_id IS NULL OR e.version_id = s.selected_version_id)
      ORDER BY coalesce(s.depth, -1), e.seq`
    )
    .all(slotId, chatId, chatId)

const plain = (rows: ReadonlyArray<unknown>) => JSON.parse(JSON.stringify(rows)) as Array<Record<string, unknown>>

/** Path rows without their forks: migration 0053 makes new ones, with new ids. */
const unforked = (rows: ReadonlyArray<unknown>) =>
  plain(rows).map(({ starts_fork_id: _, slot_fork_id: __, shown_fork_id: ___, ...row }) => row)

describe("0052_chains", () => {
  it.live(
    "indexes a realistic graph as insertion did, and every path and state read stays the same",
    () => {
      const dataDir = tempDir("chains-migration")
      return Effect.gen(function* () {
        // A realistic ST import, and a graph built with the writer: branches at the root and
        // mid-path, branches of branches, a deleted message, a deleted branch, a purged
        // branch, a deleted and a selected swipe, a hidden message, and state events at
        // shared, branch-only, deleted and version-attached positions and chat-wide.
        yield* Effect.gen(function* () {
          const root = tempDir("st-chains")
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

          const writer = yield* Database.Writer
          const userId = (yield* (yield* client()).Whoami()).id as UserId
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
            writer
              .AppendMessage({
                userId,
                chatId: chat.id,
                parentSlotId,
                branch,
                version: say(mira, `message ${n++}`, n % 2 ? "model" : "human"),
                commitDraft: null
              })
              .pipe(Effect.map((sent) => sent.slotId))
          const state = (slotId: SlotId | null, name: string, versionId: string | null = null) =>
            writer.AddStateEvent({
              userId,
              chatId: chat.id,
              slotId,
              versionId: versionId as never,
              scope: null,
              data: { key: "var.set", value: { name, value: name } }
            })
          const line = (from: SlotId, count: number) =>
            Effect.gen(function* () {
              const slots = [from]
              for (let i = 0; i < count; i++) slots.push(yield* append(slots.at(-1)!, true))
              return slots
            })
          const main = yield* line(chat.activeLeafSlotId!, 30)
          const rootBranch = yield* line(yield* append(null, true), 5)
          const mid = yield* line(main[10]!, 12)
          const nested = yield* line(mid[4]!, 6)
          const deep = yield* line(nested[2]!, 3)
          const doomed = yield* line(main[20]!, 4)
          const purged = yield* line(main[25]!, 4)
          yield* state(null, "chatwide")
          yield* state(main[5]!, "shared")
          yield* state(mid[6]!, "mid-only")
          yield* state(nested[1]!, "nested-only")
          yield* state(deep.at(-1)!, "deep-tip")
          yield* state(rootBranch[2]!, "root-branch")
          yield* state(main[12]!, "on-deleted")
          yield* state(doomed[2]!, "on-deleted-branch")
          // Swipes: one selected and attached to an event, one deleted.
          const swipe = yield* writer.AddVersion({
            userId,
            slotId: main[15]!,
            version: say(mira, "swiped", "model"),
            select: true,
            commitDraft: null
          })
          yield* state(main[15]!, "on-swipe", swipe.id)
          const unselected = yield* writer.AddVersion({
            userId,
            slotId: mid[3]!,
            version: say(mira, "other", "model"),
            select: false,
            commitDraft: null
          })
          yield* state(mid[3]!, "on-unselected", unselected.id)
          const gone = yield* writer.AddVersion({
            userId,
            slotId: main[16]!,
            version: say(mira, "gone", "model"),
            select: false,
            commitDraft: null
          })
          yield* writer.DeleteVersion({ userId, versionId: gone.id })
          yield* writer.DeleteMessage({ userId, slotId: main[12]! })
          yield* writer.DeleteBranch({ userId, slotId: doomed[1]! })
          const item = yield* writer.DeleteBranch({ userId, slotId: purged[1]! })
          yield* writer.PurgeBinItem({ userId, itemId: item.id })
          yield* writer.SetSlotHidden({ userId, slotId: main[8]!, hidden: true })
        }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ dataDir }), Generator.none)))

        // The chains insertion gave, the reads as they were before 0052 (walking up parents;
        // they don't use chains), then the database as it was before 0052 and 0053.
        const db = new DatabaseSync(databaseFile(dataDir))
        const inserted = db.prepare("SELECT id, chain_id FROM slots ORDER BY id").all()
        const placed = db.prepare("SELECT id, slot_chain_id, slot_depth FROM state_events ORDER BY id").all()
        assert.isAbove(inserted.length, 500, "the fixture should be realistic")
        assert.isAbove(new Set(inserted.map((r) => r.chain_id)).size, 20, "and branch a lot")
        const slots = db.prepare("SELECT id, chat_id, deleted_at FROM slots ORDER BY id").all() as Array<{
          id: SlotId
          chat_id: ChatId
          deleted_at: number | null
        }>
        const before = slots.map(({ id, chat_id }) => ({
          window: unforked(pathBefore(db, chat_id, id, 1000)),
          short: unforked(pathBefore(db, chat_id, id, 3)),
          events: plain(eventsBefore(db, chat_id, id))
        }))
        unmigrateForks(db)
        db.exec(`
          DROP TRIGGER slots_chain_assigned; DROP TRIGGER slots_chain_fixed;
          DROP TRIGGER state_events_chain_unplaced; DROP TRIGGER state_events_chain_assigned;
          DROP TRIGGER state_events_chain_fixed;
          DROP INDEX slots_chain; DROP INDEX state_events_chain;
          ALTER TABLE slots DROP COLUMN chain_id;
          ALTER TABLE state_events DROP COLUMN slot_chain_id; ALTER TABLE state_events DROP COLUMN slot_depth;
          DELETE FROM effect_sql_migrations WHERE name = 'chains';`)
        db.close()

        yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(
          Effect.provide(writerConnection(databaseFile(dataDir)))
        )

        const after = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
        assert.deepStrictEqual(
          plain(after.prepare("SELECT id, chain_id FROM slots ORDER BY id").all()),
          plain(inserted)
        )
        assert.deepStrictEqual(
          plain(after.prepare("SELECT id, slot_chain_id, slot_depth FROM state_events ORDER BY id").all()),
          plain(placed)
        )
        after.close()
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          for (const [i, { id, chat_id }] of slots.entries()) {
            assert.deepStrictEqual(unforked(yield* pathWindow(sql, chat_id, id, 1000)), before[i]!.window, id)
            assert.deepStrictEqual(unforked(yield* pathWindow(sql, chat_id, id, 3)), before[i]!.short, id)
            assert.deepStrictEqual(plain(yield* stateEventsOnPath(sql, chat_id, id)), before[i]!.events, id)
          }
        }).pipe(Effect.provide(readOnly(dataDir)))
        // The events check isn't vacuous: some slots see several, and branches see different ones.
        assert.isAbove(new Set(before.map((b) => JSON.stringify(b.events))).size, 5)
      })
    },
    180_000
  )

  it.effect("refuses a slot outside its chat's first lane", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord(Object.fromEntries(Object.entries(migrations).filter(([k]) => k < "0052")))
      })
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'u', 'admin', 1)`
      yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES ('chat', 'u', 'rp', 'active', 1)`
      yield* sql`INSERT INTO lanes (id, chat_id, name, created_at) VALUES ('main', 'chat', 'main', 1), ('side', 'chat', 'side', 2)`
      yield* Effect.gen(function* () {
        yield* sql`INSERT INTO versions (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at)
          VALUES ('v', 's', 0, 'complete', 'human', 'x', 'verbatim', 'user_written', 1, 1)`
        yield* sql`INSERT INTO slots (id, chat_id, lane_id, parent_slot_id, depth, selected_version_id, created_at)
          VALUES ('s', 'chat', 'side', NULL, 0, 'v', 1)`
      }).pipe(sql.withTransaction)
      const exit = yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
      const columns = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('slots') WHERE name = 'chain_id'`
      assert.deepStrictEqual(columns, [])
    }).pipe(Effect.provide(writerConnection(join(tempDir("chains"), "db.sqlite"))))
  )
})
