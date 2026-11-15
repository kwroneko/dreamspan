// Which forks' shell summaries a write reaches (db/summaryValidity.ts), on a migrated database
// written directly: each write in its own write transaction, then the forks whose summary is
// no longer valid (`summaryValidSql`). The tree: r → a → b → c (main's tip), x under a (X's
// tip), y under b (Y's tip). Main is the chat's first fork (its id is the chat's); X and Y
// were made from it at its sequence number 5.
import { join } from "node:path"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { writerConnection } from "../src/db/connection.ts"
import { storeSummaries } from "../src/db/forkSummaries.ts"
import { migrations } from "../src/db/migrations.ts"
import {
  FORK_SUMMARY_FORMAT,
  settleSummaries,
  summaryValidSql,
  trackSummaryTouches
} from "../src/db/summaryValidity.ts"
import { transaction } from "../src/db/tx.ts"
import { tempDir } from "./support/tempDir.ts"

const FORKS = ["main", "X", "Y"] as const

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
  yield* trackSummaryTouches(sql)
  yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'u', 'admin', 1)`
  for (const chat of ["main", "other"])
    yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES (${chat}, 'u', 'rp', 'active', 1)`
  const slot = (id: string, parent: string | null, depth: number, chat = "main") =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at, authoring_fork_id)
        VALUES (${`v-${id}`}, ${id}, 0, 'complete', 'human', 'x', 'verbatim', 'user_written', 1, 1, ${chat} )`
      yield* sql`INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, created_at)
        VALUES (${id}, ${chat}, ${parent}, ${depth}, ${`v-${id}`}, 1)`
    }).pipe(sql.withTransaction)
  yield* slot("r", null, 0)
  yield* slot("a", "r", 1)
  yield* slot("b", "a", 2)
  yield* slot("c", "b", 3)
  yield* slot("x", "a", 2)
  yield* slot("y", "b", 3)
  yield* slot("o1", null, 0, "other")
  yield* sql`UPDATE forks SET tip_slot_id = 'c' WHERE id = 'main'`
  yield* sql`UPDATE forks SET tip_slot_id = 'o1' WHERE id = 'other'`
  // Written before X and Y were made, as their numbers say.
  yield* sql`INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id)
    VALUES ('old', 'main', 'main', 3, 'select', 'a', 'a', 1, 'v-a')`
  yield* sql`INSERT INTO state_events (id, chat_id, slot_id, seq, key, value_json, origin, created_at, fork_id, fork_seq)
    VALUES ('ev', 'main', 'b', 0, 'var.set', '{}', 'user', 1, 'main', 2)`
  const fork = (id: string, tip: string) =>
    sql`INSERT INTO forks (id, chat_id, parent_fork_id, branched_at, tip_slot_id, created_at)
      VALUES (${id}, 'main', 'main', 5, ${tip}, 1)`
  yield* fork("X", "x")
  yield* fork("Y", "y")

  /** Every fork's summary valid at its chat's stamp now, and nothing noted. */
  const allValid = Effect.gen(function* () {
    yield* settleSummaries(sql)
    yield* sql`DELETE FROM fork_summaries`
    yield* sql`INSERT INTO fork_summaries (fork_id, chat_id, format, stamp, user_stamp, preview, messages, leaf,
        end_at, cast_json, joined_json, departed_json, activity_json)
      SELECT f.id, f.chat_id, ${FORK_SUMMARY_FORMAT}, c.shell_stamp, 0, '', 0, NULL, NULL, '[]', '[]', '[]', '[]'
      FROM forks f JOIN chats c ON c.id = f.chat_id`
  })
  const stale = sql<{ fork_id: string }>`SELECT s.fork_id FROM fork_summaries s JOIN chats c ON c.id = s.chat_id
    WHERE NOT ${sql.literal(summaryValidSql("s", "c", "0"))} ORDER BY s.fork_id`.pipe(
    Effect.map((rows) => rows.map((r) => r.fork_id))
  )
  /** The forks `write`, as one write operation, leaves stale. */
  const reached = (write: Effect.Effect<unknown, unknown>) =>
    Effect.gen(function* () {
      yield* allValid
      yield* write.pipe(transaction(sql, "Test"))
      return yield* stale
    })
  return { sql, slot, reached, allValid, stale }
})

const run = <A, E>(body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  body.pipe(Effect.provide(writerConnection(join(tempDir("summary-validity"), "db.sqlite"))))

describe("per-fork summary validity", () => {
  it.effect("multiple new alternatives cannot hide each other's new participation", () =>
    run(
      Effect.gen(function* () {
        const { sql, reached } = yield* setup
        yield* sql`INSERT INTO entities(id, owner_user_id, kind, created_at) VALUES ('speaker', 'u', 'card', 1)`
        const add = (id: string, ordinal: number) => sql`INSERT INTO version_records
        (id, slot_id, ordinal, status, writer, speaker_entity_id, content, macro_mode, origin, created_at, updated_at, authoring_fork_id)
        VALUES (${id}, 'a', ${ordinal}, 'complete', 'model', 'speaker', 'x', 'verbatim', 'generated', 1, 1, 'main' )`
        assert.deepStrictEqual(yield* reached(Effect.andThen(add("new1", 1), add("new2", 2))), [...FORKS].sort())
        assert.deepStrictEqual(yield* reached(add("new3", 3)), [])
      })
    )
  )
  it.effect("a tip move walks descendant paths only when the fork has children", () =>
    run(
      Effect.gen(function* () {
        const { sql, reached } = yield* setup
        const move = (tip: string, expectedTouches: number) =>
          Effect.gen(function* () {
            yield* sql`UPDATE forks SET tip_slot_id = ${tip} WHERE id = 'X'`
            const [row] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM shell_touches WHERE kind = 'tip'`
            assert.strictEqual(row!.n, expectedTouches)
          })
        assert.deepStrictEqual(yield* reached(move("c", 0)), ["X"])
        yield* sql`INSERT INTO forks (id, chat_id, parent_fork_id, branched_at, tip_slot_id, created_at)
          VALUES ('child', 'main', 'X', 5, 'c', 1)`
        assert.deepStrictEqual(yield* reached(move("x", 1)), ["X", "child"])
      })
    )
  )

  it.effect("a write to a slot reaches every fork whose path holds it, and only those", () =>
    run(
      Effect.gen(function* () {
        const { sql, slot, reached } = yield* setup
        const all = [...FORKS].sort()
        // The shared root and a: every fork; b: main and Y; c and x: their own fork.
        assert.deepStrictEqual(yield* reached(sql`UPDATE slots SET selected_version_id = 'v-r' WHERE id = 'r'`), all)
        assert.deepStrictEqual(yield* reached(sql`UPDATE slots SET purged_at = 9 WHERE id = 'a'`), all)
        assert.deepStrictEqual(yield* reached(sql`UPDATE slots SET deleted_at = NULL WHERE id = 'b'`), ["Y", "main"])
        assert.deepStrictEqual(yield* reached(sql`UPDATE slots SET created_at = 2 WHERE id = 'c'`), ["main"])
        assert.deepStrictEqual(yield* reached(sql`UPDATE slots SET purged_at = 2 WHERE id = 'x'`), ["X"])
        // An edit of a shared slot's version, or its deletion.
        assert.deepStrictEqual(yield* reached(sql`UPDATE version_records SET content = 'edited' WHERE id = 'v-b'`), [
          "Y",
          "main"
        ])
        yield* sql`INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at, authoring_fork_id)
          VALUES ('v-a2', 'a', 1, 'complete', 'human', 'swipe', 'verbatim', 'user_written', 1, 1, 'main' )`
        assert.deepStrictEqual(yield* reached(sql`DELETE FROM versions WHERE id = 'v-a2'`), all)
        // An anonymous alternative with no new cast contributes no participation/activity.
        // A new slot is on no path until a fork's tip moves to it, which reaches that fork.
        assert.deepStrictEqual(
          yield* reached(sql`INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin,
            created_at, updated_at, authoring_fork_id) VALUES ('v-a3', 'a', 2, 'complete', 'human', 'swipe', 'verbatim', 'user_written', 1, 1, 'main' )`),
          []
        )
        assert.deepStrictEqual(yield* reached(slot("d", "c", 4)), [])
        assert.deepStrictEqual(
          yield* reached(Effect.andThen(slot("e", "b", 3), sql`UPDATE forks SET tip_slot_id = 'e' WHERE id = 'Y'`)),
          ["Y"]
        )
        // A slot removed: every fork of its chat.
        assert.deepStrictEqual(
          yield* reached(
            Effect.andThen(sql`DELETE FROM versions WHERE slot_id = 'd'`, sql`DELETE FROM slots WHERE id = 'd'`)
          ),
          all
        )
        // Another chat's write reaches none of this one's.
        assert.deepStrictEqual(yield* reached(sql`UPDATE slots SET created_at = 3 WHERE id = 'o1'`), ["other"])
      })
    )
  )

  it.effect("a fork's own choices and events reach the forks whose lineage holds them", () =>
    run(
      Effect.gen(function* () {
        const { sql, reached } = yield* setup
        const all = [...FORKS].sort()
        const override = (id: string, fork: string, seq: number, kind: string) =>
          sql`INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id, flag)
            VALUES (${id}, 'main', ${fork}, ${seq}, ${kind}, 'b', 'b', 2, 'v-b', 1)`
        // Main's choices after X and Y were made from it are main's; one from before reaches them.
        assert.deepStrictEqual(yield* reached(override("s1", "main", 10, "select")), ["main"])
        assert.deepStrictEqual(yield* reached(override("s2", "X", 11, "delete_slot")), ["X"])
        assert.deepStrictEqual(yield* reached(sql`UPDATE fork_overrides SET flag = 1, seq = 12 WHERE id = 'old'`), all)
        // Kinds the summaries don't read move nothing; insertion placement is fork-owned.
        assert.deepStrictEqual(yield* reached(override("h1", "Y", 13, "hide")), [])
        yield* Effect.andThen(
          sql`INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at,
            updated_at, authoring_fork_id) VALUES ('v-i', 'i', 0, 'complete', 'human', 'x', 'verbatim', 'user_written', 1, 1, 'main' )`,
          sql`INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, created_at, inserted)
            VALUES ('i', 'main', 'b', 3, 'v-i', 1, 1)`
        ).pipe(sql.withTransaction)
        assert.deepStrictEqual(
          yield* reached(sql`INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, flag)
            VALUES ('i1', 'main', 'Y', 14, 'insert', 'i', 'b', 2, 1)`),
          ["Y"]
        )
        // Structural slots retain precise reachability in a chat with insertions.
        assert.deepStrictEqual(yield* reached(sql`UPDATE slots SET created_at = 7 WHERE id = 'c'`), ["main"])
        // Inserted-slot changes still conservatively reach the whole chat.
        assert.deepStrictEqual(yield* reached(sql`UPDATE slots SET created_at = 8 WHERE id = 'i'`), all)
        // State events: in one fork, chat-wide, or removed.
        const event = (id: string, fork: string | null, seq: number | null) =>
          sql`INSERT INTO state_events (id, chat_id, slot_id, seq, key, value_json, origin, created_at, fork_id, fork_seq)
            VALUES (${id}, 'main', 'b', 1, 'var.set', '{}', 'user', 1, ${fork}, ${seq})`
        assert.deepStrictEqual(yield* reached(event("e1", "Y", 15)), ["Y"])
        assert.deepStrictEqual(yield* reached(event("e2", "main", 4)), all)
        assert.deepStrictEqual(yield* reached(event("e3", null, null)), all)
        assert.deepStrictEqual(yield* reached(sql`DELETE FROM state_events WHERE id = 'e1'`), all)
        // A fork's own row: that fork.
        assert.deepStrictEqual(yield* reached(sql`UPDATE forks SET deleted_at = 1 WHERE id = 'X'`), ["X"])
      })
    )
  )

  it.effect("a summary stale before the write stays stale, and a rolled-back write notes nothing", () =>
    run(
      Effect.gen(function* () {
        const { sql, allValid, stale } = yield* setup
        yield* allValid
        yield* sql`UPDATE slots SET created_at = 5 WHERE id = 'c'`.pipe(transaction(sql, "Test"))
        assert.deepStrictEqual(yield* stale, ["main"])
        yield* sql`UPDATE slots SET created_at = 5 WHERE id = 'x'`.pipe(transaction(sql, "Test"))
        assert.deepStrictEqual(yield* stale, ["X", "main"])
        // Written outside a write operation, then failed: the notes go with the rollback.
        yield* allValid
        const failed = yield* Effect.andThen(
          sql`UPDATE slots SET created_at = 6 WHERE id = 'r'`,
          Effect.fail("refused")
        ).pipe(transaction(sql, "Test"), Effect.exit)
        assert.isTrue(Exit.isFailure(failed))
        yield* sql`UPDATE slots SET created_at = 6 WHERE id = 'y'`.pipe(transaction(sql, "Test"))
        assert.deepStrictEqual(yield* stale, ["Y"])
      })
    )
  )

  /** A summary of each fork as a read at chat stamp `stamp` would hand it to `storeSummaries`. */
  const claim = (stamp: number, forks: ReadonlyArray<string>) => [
    {
      chatId: "main",
      stamp,
      userStamp: 0,
      forks: JSON.stringify(
        forks.map((forkId) => ({
          forkId,
          chatId: "main",
          preview: forkId,
          messages: 1,
          leaf: null,
          endAt: null,
          split: null,
          cast: [],
          added: [],
          joined: [],
          departed: [],
          activity: [],
          threads: []
        }))
      )
    }
  ]
  const chatStamp = (sql: SqlClient.SqlClient) =>
    Effect.map(sql<{ s: number }>`SELECT shell_stamp AS s FROM chats WHERE id = 'main'`, ([row]) => row!.s)

  it.effect("a summary computed before a write to another fork is stored; one the write reached isn't", () =>
    run(
      Effect.gen(function* () {
        const { sql, allValid } = yield* setup
        yield* allValid
        const before = yield* chatStamp(sql)
        yield* sql`DELETE FROM fork_summaries`
        // Reaches X only, after the read at `before` began.
        yield* sql`UPDATE slots SET created_at = 7 WHERE id = 'x'`.pipe(transaction(sql, "Test"))
        assert.isAbove(yield* chatStamp(sql), before)
        yield* storeSummaries(sql, "u", claim(before, FORKS)).pipe(transaction(sql, "Test"))
        const stored = yield* sql<{ fork_id: string; stamp: number }>`SELECT fork_id, stamp FROM fork_summaries
          ORDER BY fork_id`
        assert.deepStrictEqual(
          stored.map((row) => row.fork_id),
          ["Y", "main"]
        )
        assert.isTrue(stored.every((row) => row.stamp === before))
        const valid = yield* sql<{
          fork_id: string
        }>`SELECT s.fork_id FROM fork_summaries s JOIN chats c ON c.id = s.chat_id
          WHERE ${sql.literal(summaryValidSql("s", "c", "0"))} ORDER BY s.fork_id`
        assert.deepStrictEqual(
          valid.map((row) => row.fork_id),
          ["Y", "main"]
        )
      })
    )
  )

  it.effect("settling a write moves only the stamps of the forks it reaches", () =>
    run(
      Effect.gen(function* () {
        const { sql, allValid } = yield* setup
        yield* allValid
        const stamps = sql<{ fork_id: string; stamp: number }>`SELECT fork_id, stamp FROM fork_shell_stamps
          ORDER BY fork_id`
        const before = yield* stamps
        yield* sql`UPDATE slots SET created_at = 8 WHERE id = 'y'`.pipe(transaction(sql, "Test"))
        const after = yield* stamps
        const now = yield* chatStamp(sql)
        assert.deepStrictEqual(
          after,
          before.map((row) => (row.fork_id === "Y" ? { ...row, stamp: now } : row))
        )
      })
    )
  )

  it.effect("a stamp moved without notes stales the whole chat until a noted write", () =>
    run(
      Effect.gen(function* () {
        const { sql, allValid, stale } = yield* setup
        yield* allValid
        // As another connection would: the stamp moves, nothing is noted.
        yield* sql`UPDATE chats SET shell_stamp = shell_stamp + 1 WHERE id = 'main'`
        yield* sql`DELETE FROM shell_moved`
        yield* sql`DELETE FROM shell_touches`
        assert.deepStrictEqual(yield* stale, [...FORKS].sort())
        // A summary computed after the move can't be told from one computed before it until
        // the stamps are noted again: storing reaches every fork first.
        const now = yield* chatStamp(sql)
        yield* storeSummaries(sql, "u", claim(now - 1, ["main"])).pipe(transaction(sql, "Test"))
        assert.deepStrictEqual(yield* stale, [...FORKS].sort())
        yield* storeSummaries(sql, "u", claim(now, FORKS)).pipe(transaction(sql, "Test"))
        assert.deepStrictEqual(yield* stale, [])
        // A noted write that reaches X alone, after another unnoted move: every fork.
        yield* sql`UPDATE chats SET shell_stamp = shell_stamp + 1 WHERE id = 'main'`
        yield* sql`DELETE FROM shell_moved`
        yield* sql`UPDATE slots SET created_at = 9 WHERE id = 'x'`.pipe(transaction(sql, "Test"))
        assert.deepStrictEqual(yield* stale, [...FORKS].sort())
      })
    )
  )
  it.effect("a summary computed at the chat's stamp now is valid before any write was noted", () =>
    run(
      Effect.gen(function* () {
        const { sql, allValid, stale } = yield* setup
        // As summaries stored by another connection, or before the notes were installed.
        yield* allValid
        yield* sql`DELETE FROM chat_shell_tracked`
        yield* sql`DELETE FROM fork_shell_stamps`
        assert.deepStrictEqual(yield* stale, [])
        // One computed before an unnoted move isn't.
        yield* sql`UPDATE chats SET shell_stamp = shell_stamp + 1 WHERE id = 'main'`
        yield* sql`DELETE FROM shell_moved`
        yield* sql`DELETE FROM shell_touches`
        assert.deepStrictEqual(yield* stale, [...FORKS].sort())
      })
    )
  )
})
