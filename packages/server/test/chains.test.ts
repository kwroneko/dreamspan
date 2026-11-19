// Chains (spec/FORK-INDEPENDENCE-DELTA.md §2.1, implementation unit 1): how the database
// assigns them, the triggers that keep them, and the segments a path is read by.
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { type ChatId, type EntityId, NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { databaseFile, writerConnection } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { migrations } from "../src/db/migrations.ts"
import { pathSegments } from "../src/db/pathSegments.ts"
import { docFor } from "./support/docs.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

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
      }).pipe(Effect.provide(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers })))

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
      const slot = (id: string, parent: string | null, depth: number, chain: string | null = null) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at, authoring_fork_id)
            VALUES (${`v-${id}`}, ${id}, 0, 'complete', 'human', 'x', 'verbatim', 'user_written', 1, 1, 'chat' )`
          yield* sql`INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, created_at, chain_id)
            VALUES (${id}, 'chat', ${parent}, ${depth}, ${`v-${id}`}, 1, ${chain})`
        }).pipe(sql.withTransaction)
      const chain = (id: string) =>
        sql<{ chain_id: string }>`SELECT chain_id FROM slots WHERE id = ${id}`.pipe(Effect.map(([r]) => r!.chain_id))
      const refused = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.exit, Effect.map(Exit.isFailure))

      yield* slot("r", null, 0)
      yield* slot("a", "r", 1)
      yield* slot("b", "r", 1)
      // The first child continues its parent chain; the next child starts a new one.
      yield* slot("l", "a", 2)
      yield* slot("m", "a", 2)
      assert.deepStrictEqual(
        [yield* chain("r"), yield* chain("a"), yield* chain("b"), yield* chain("l"), yield* chain("m")],
        ["r", "r", "b", "r", "m"]
      )
      // Nothing moves a slot to another chain, or inserts one with a chain other than its own.
      assert.isTrue(yield* refused(sql`UPDATE slots SET chain_id = 'b' WHERE id = 'a'`))
      assert.isTrue(yield* refused(slot("x", "b", 2, "r")))
      assert.isTrue(yield* refused(slot("y", "m", 3, "y")))
      yield* slot("z", "m", 3, "m") // its own chain, stated
      assert.strictEqual(yield* chain("z"), "m")

      const event = (id: string, slotId: string | null, extra = sql``) =>
        sql`INSERT INTO state_events (id, chat_id, slot_id, seq, key, value_json, origin, created_at ${extra})
          VALUES (${id}, 'chat', ${slotId}, 0, 'var.set', '{}', 'user', 1)`
      yield* event("e1", "m")
      yield* event("e2", null)
      const placed = yield* sql<{ id: string; slot_chain_id: string | null; slot_depth: number | null }>`
        SELECT id, slot_chain_id, slot_depth FROM state_events ORDER BY id`
      assert.deepStrictEqual(placed, [
        { id: "e1", slot_chain_id: "m", slot_depth: 2 },
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

  it.effect(
    "give an inserted slot a chain like any other, one level below its anchor (spec/MESSAGE-INSERT.md §2.2)",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
        yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'u', 'admin', 1)`
        yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES ('chat', 'u', 'rp', 'active', 1)`
        const slot = (id: string, parent: string | null, depth: number, inserted = 0) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at, authoring_fork_id)
            VALUES (${`v-${id}`}, ${id}, 0, 'complete', 'human', 'x', 'verbatim', 'user_written', 1, 1, 'chat' )`
            yield* sql`INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, created_at, inserted)
            VALUES (${id}, 'chat', ${parent}, ${depth}, ${`v-${id}`}, 1, ${inserted})`
          }).pipe(sql.withTransaction)
        const placed = (id: string) =>
          sql<{ chain_id: string; depth: number }>`SELECT chain_id, depth FROM slots WHERE id = ${id}`.pipe(
            Effect.map(([r]) => r!)
          )
        yield* slot("r", null, 0)
        yield* slot("a", "r", 1)
        yield* slot("b", "a", 2)
        // Below a message with a reply: a later child, so a chain of its own.
        yield* slot("x", "a", 2, 1)
        // Below the tip: the first child, so it continues the anchor's chain, and the next reply starts one.
        yield* slot("y", "b", 3, 1)
        yield* slot("c", "b", 3)
        // Above the first message: a root.
        yield* slot("top", null, 0, 1)
        assert.deepStrictEqual(
          [yield* placed("x"), yield* placed("y"), yield* placed("c"), yield* placed("top")],
          [
            { chain_id: "x", depth: 2 },
            { chain_id: "r", depth: 3 },
            { chain_id: "c", depth: 3 },
            { chain_id: "top", depth: 0 }
          ]
        )
        // The structural path to c doesn't hold y, though y has c's depth on c's parent's chain.
        const segments = yield* sql<{ chain_id: string; lo: number; hi: number }>`
        ${pathSegments(sql, "chat", "c", null)} SELECT chain_id, lo, hi FROM segments`
        assert.deepStrictEqual(segments, [
          { chain_id: "c", lo: 3, hi: 3 },
          { chain_id: "r", lo: 0, hi: 2 }
        ])
        // An inserted slot is still one level below its parent, in its chat.
        const refused = yield* slot("z", "a", 3, 1).pipe(Effect.exit, Effect.map(Exit.isFailure))
        assert.isTrue(refused)
      }).pipe(Effect.provide(writerConnection(join(tempDir("chains"), "db.sqlite"))))
  )
})
