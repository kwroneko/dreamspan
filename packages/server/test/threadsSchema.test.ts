import { threadLabels } from "../src/db/threadReads.ts"
// Parallel threads' stored shape (spec/THREADS.md §4, TH1): the tables' triggers on a bare
// migrated database, and which thread each fork is in (db/threads.ts) against a lineage oracle
// over random fork trees with nested splits, before and after `rebuildForkLabels` recomputes
// every label from seqs (also under a paused rebuild, as a bulk import runs). Synthetic data only.
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { writerConnection } from "../src/db/connection.ts"
import { rebuildForkLabels } from "../src/db/forkLabels.ts"
import { insertFork, nextSeq } from "../src/db/forkState.ts"
import { migrate, migrationDefinitions } from "../src/db/migrations.ts"
import { knowsSql, readKnowers } from "../src/db/knowers.ts"
import type { ForkRow } from "../src/db/rows.ts"
import { installStorageKindValidation } from "../src/db/storageKinds.ts"
import { transaction } from "../src/db/tx.ts"
import {
  insertCorrections,
  insertSplit,
  insertThreadMember,
  placesOf,
  shownSplits,
  threadCandidates
} from "../src/db/threads.ts"
import { tempDir } from "./support/tempDir.ts"

const CHAT = "c"
const SLOTS = ["r", "s1", "s2", "s3"] as const

const random = (seed: number) => {
  let a = seed >>> 0
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
  }
}

const addChat = (sql: SqlClient.SqlClient, chat: string, slots: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES (${chat}, 'u', 'rp', 'active', 1)`
    for (const [depth, id] of slots.entries()) {
      yield* sql`INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at, authoring_fork_id)
        VALUES (${`v-${id}`}, ${id}, 0, 'complete', 'human', 'x', 'verbatim', 'user_written', 1, 1, ${chat})`
      yield* sql`INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, created_at)
        VALUES (${id}, ${chat}, ${depth === 0 ? null : slots[depth - 1]!}, ${depth}, ${`v-${id}`}, 1)`
    }
    yield* sql`UPDATE forks SET tip_slot_id = ${slots[slots.length - 1]!} WHERE id = ${chat}`
  }).pipe(sql.withTransaction)

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* migrate(migrationDefinitions)
  yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'u', 'admin', 1)`
  yield* addChat(sql, CHAT, SLOTS)
  return sql
})

const forkRow = (sql: SqlClient.SqlClient, id: string) =>
  Effect.map(sql<ForkRow>`SELECT * FROM forks WHERE id = ${id}`, ([row]) => row!)

const child = (sql: SqlClient.SqlClient, parent: string, base: string) =>
  Effect.gen(function* () {
    const made = yield* insertFork(sql, {
      chatId: CHAT,
      parent: yield* forkRow(sql, parent),
      baseSlotId: base,
      tipSlotId: base,
      at: 1
    })
    return made.id
  })

/** Splits fork `fork` at `slot` into `threads` threads (the fork continuing, and new forks). */
const split = (sql: SqlClient.SqlClient, fork: string, slot: string, threads: number) =>
  Effect.gen(function* () {
    const made = yield* insertSplit(sql, { chatId: CHAT, slotId: slot, forkId: fork, at: 1 })
    const members: Array<string> = []
    for (let ordinal = 1; ordinal < threads; ordinal++) {
      const id = yield* child(sql, fork, slot)
      yield* insertThreadMember(sql, { splitId: made.id, ordinal, forkId: id, starts: true, name: null })
      members.push(id)
    }
    return { id: made.id, members }
  }).pipe(sql.withTransaction)

const refused = <A, E>(effect: Effect.Effect<A, E>) => {
  const where = new Error().stack?.split("\n")[2]?.trim() ?? ""
  return Effect.map(Effect.exit(effect), (exit) => assert.isTrue(Exit.isFailure(exit), `refused ${where}`))
}

describe("thread tables", () => {
  it.effect("an explicit absence also protects messages whose cast was not recorded", () =>
    Effect.gen(function* () {
      const sql = yield* setup
      const one = yield* split(sql, CHAT, "s1", 2)
      yield* insertCorrections(sql, { id: one.id, chatId: CHAT, forkId: CHAT }, ["s2"], ["card"])
      const [found] = yield* readKnowers(sql, CHAT, sql`1`, ["v-s2"], null, CHAT)
      assert.deepStrictEqual(found!.away, ["card"])
      const [known] = yield* sql<{ knows: number }>`SELECT ${yield* knowsSql(sql, ["card"], CHAT)} AS knows
        FROM slots s JOIN version_records v ON v.slot_id = s.id WHERE v.id = 'v-s2'`
      assert.strictEqual(known!.knows, 0)
    }).pipe(Effect.provide(writerConnection(join(tempDir("threads-unknown-cast"), "db.sqlite"))))
  )

  it.effect("thread labels add reads per member, never per fork", () =>
    Effect.gen(function* () {
      const sql = yield* setup
      const made = yield* split(sql, CHAT, "s1", 2)
      let queries = 0
      const measured = new Proxy(sql, {
        apply(target, receiver, args) {
          queries++
          return Reflect.apply(target, receiver, args)
        }
      })
      const row = { forkId: made.members[0]!, chatId: CHAT, place: { splitId: made.id, ordinal: 1 } }
      yield* threadLabels(measured, [row])
      const one = queries
      queries = 0
      const labels = yield* threadLabels(
        measured,
        Array.from({ length: 300 }, (_, i) => ({ ...row, forkId: `shown-${i}` }))
      )
      assert.strictEqual(labels.size, 300)
      assert.strictEqual(queries, one)
    }).pipe(Effect.provide(writerConnection(join(tempDir("threads-label-queries"), "db.sqlite"))))
  )

  it.effect("knowledge windows in chats without threads use one query", () =>
    Effect.gen(function* () {
      const sql = yield* setup
      let queries = 0
      const measured = new Proxy(sql, {
        apply(target, receiver, args) {
          if (/^\s*SELECT\b/.test(args[0][0])) queries++
          return Reflect.apply(target, receiver, args)
        }
      })
      const found = yield* readKnowers(measured, CHAT, sql`1`, ["v-s1"], null, CHAT)
      assert.deepStrictEqual(found, [{ versionId: "v-s1", knowers: null }])
      assert.strictEqual(queries, 1)
    }).pipe(Effect.provide(writerConnection(join(tempDir("threads-no-queries"), "db.sqlite"))))
  )

  it.effect("keep a split's message, branch and members consistent and frozen", () =>
    Effect.gen(function* () {
      const sql = yield* setup
      yield* addChat(sql, "other", ["x0", "x1"])
      const one = yield* split(sql, CHAT, "s2", 3)
      const [row] = yield* sql<{ seq: number; fork_label: Uint8Array }>`SELECT seq, fork_label FROM thread_splits`
      assert.isTrue(row!.seq > 0)

      // Its message and branch are in its chat.
      yield* refused(sql`INSERT INTO thread_splits (id, chat_id, slot_id, fork_id, fork_label, seq, created_at)
        VALUES ('bad', ${CHAT}, 'x1', ${CHAT}, X'00', 1, 1)`)
      yield* refused(sql`INSERT INTO thread_splits (id, chat_id, slot_id, fork_id, fork_label, seq, created_at)
        VALUES ('bad', ${CHAT}, 's1', 'other', X'00', 1, 1)`)
      // Frozen: its message, its branch; its label outside a paused rebuild.
      yield* refused(sql`UPDATE thread_splits SET slot_id = 's1' WHERE id = ${one.id}`)
      yield* refused(
        sql`UPDATE thread_splits SET fork_label = ${Uint8Array.of(...row!.fork_label, 0)} WHERE id = ${one.id}`
      )
      yield* sql`INSERT INTO fork_label_pause VALUES (1)`
      yield* sql`UPDATE thread_splits SET fork_label = ${Uint8Array.of(...row!.fork_label, 0)} WHERE id = ${one.id}`
      yield* sql`DELETE FROM fork_label_pause`

      // One continuing member, which is the split's branch; new ones are its forks made at S.
      yield* refused(insertThreadMember(sql, { splitId: one.id, ordinal: 5, forkId: CHAT, starts: false, name: null }))
      const stranger = yield* child(sql, CHAT, "s1")
      yield* refused(
        insertThreadMember(sql, { splitId: one.id, ordinal: 5, forkId: stranger, starts: true, name: null })
      )
      const grandchild = yield* child(sql, one.members[0]!, "s2")
      yield* refused(
        insertThreadMember(sql, { splitId: one.id, ordinal: 5, forkId: grandchild, starts: true, name: null })
      )
      // A fork starts one thread only.
      yield* refused(
        insertThreadMember(sql, { splitId: one.id, ordinal: 5, forkId: one.members[0]!, starts: true, name: null })
      )
      // A member keeps its place and branch; its name changes.
      yield* refused(sql`UPDATE thread_members SET fork_id = ${stranger} WHERE split_id = ${one.id} AND ordinal = 1`)
      yield* sql`UPDATE thread_members SET name = 'Kitchen', name_user = 1, row_version = row_version + 1
        WHERE split_id = ${one.id} AND ordinal = 1`

      // Send groups stay in one chat and never change.
      yield* sql`INSERT INTO thread_sends (slot_id, chat_id, group_id) VALUES ('s3', ${CHAT}, 'g')`
      yield* refused(sql`INSERT INTO thread_sends (slot_id, chat_id, group_id) VALUES ('x1', 'other', 'g')`)
      yield* refused(sql`INSERT INTO thread_sends (slot_id, chat_id, group_id) VALUES ('x1', ${CHAT}, 'h')`)
      yield* refused(sql`UPDATE thread_sends SET group_id = 'h'`)
    }).pipe(Effect.provide(writerConnection(join(tempDir("threads-schema"), "db.sqlite"))))
  )

  it.effect("take only registered origins, Undo kinds and correction kinds in a writer transaction", () =>
    Effect.gen(function* () {
      const sql = yield* setup
      yield* installStorageKindValidation
      const tx = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(transaction(sql, "ThreadKinds"))
      const splitAs = (id: string, origin: string) =>
        tx(sql`INSERT INTO thread_splits (id, chat_id, slot_id, fork_id, fork_label, seq, origin, created_at)
          VALUES (${id}, ${CHAT}, 's1', ${CHAT}, X'00', 1, ${origin}, 1)`)
      yield* refused(splitAs("bad", "nobody"))
      yield* splitAs("rollout", "rollout")
      yield* splitAs("import", "import")
      const binAs = (id: string, kind: string) =>
        tx(sql`INSERT INTO bin_items (id, user_id, chat_id, kind, target_id, title, excerpt, origin_json, byte_size, deleted_at)
          VALUES (${id}, 'u', ${CHAT}, ${kind}, ${CHAT}, 'Threads', '', '{}', 0, 1)`)
      yield* refused(binAs("bad", "thread"))
      yield* binAs("ok", "threads")
      yield* tx(sql`INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id, flag)
        VALUES ('away', ${CHAT}, ${CHAT}, 1, 'presence_away', 's1:card', 's1', 1, '{"rollout":true}', 1)`)
      const [merge] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM pragma_table_info('chat_merges')
        WHERE name IN ('timelines', 'split_id')`
      assert.strictEqual(merge!.n, 2)
    }).pipe(Effect.provide(writerConnection(join(tempDir("threads-kinds"), "db.sqlite"))))
  )

  it.effect("check presence corrections and the new kinds, and go with their chat", () =>
    Effect.gen(function* () {
      const sql = yield* setup
      const one = yield* split(sql, CHAT, "s1", 2)
      const seq = yield* nextSeq(sql, CHAT)
      const correction = (id: string, target: string, slot: string | null, depth: number | null, flag: number | null) =>
        sql`INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id, flag)
          VALUES (${id}, ${CHAT}, ${CHAT}, ${seq}, 'presence_away', ${target}, ${slot}, ${depth}, ${JSON.stringify({ [one.id]: true })}, ${flag})`
      yield* correction("ok", "s2:card", "s2", 2, 1)
      yield* refused(correction("no-flag", "s2:card", "s2", 2, null))
      yield* refused(correction("no-slot", "s2:card", null, null, 1))
      yield* refused(correction("wrong-depth", "s2:card", "s2", 1, 1))
      yield* refused(correction("wrong-slot", "s3:card", "s2", 2, 1))
      yield* refused(correction("no-card", "s2:", "s2", 2, 1))
      yield* refused(sql`UPDATE fork_overrides SET flag = NULL WHERE id = 'ok'`)
      yield* sql`UPDATE fork_overrides SET flag = 0 WHERE id = 'ok'`

      // An Undo in the bin is named on its split, which keeps it while it's there.
      yield* sql`INSERT INTO bin_items (id, user_id, chat_id, kind, target_id, title, excerpt, origin_json, byte_size, deleted_at)
        VALUES ('bin', 'u', ${CHAT}, 'threads', ${one.members[0]!}, 'Threads', '', '{}', 0, 1)`
      yield* sql`UPDATE thread_splits SET bin_item_id = 'bin' WHERE id = ${one.id}`

      // Deleting the chat takes its splits, members, sends and corrections.
      yield* sql`INSERT INTO thread_sends (slot_id, chat_id, group_id) VALUES ('s3', ${CHAT}, 'g')`
      yield* sql`DELETE FROM bin_items`
      yield* sql`DELETE FROM chats WHERE id = ${CHAT}`
      const [left] = yield* sql<{
        n: number
      }>`SELECT (SELECT count(*) FROM thread_splits) + (SELECT count(*) FROM thread_members)
        + (SELECT count(*) FROM thread_sends) + (SELECT count(*) FROM fork_overrides) AS n`
      assert.strictEqual(left!.n, 0)
    }).pipe(Effect.provide(writerConnection(join(tempDir("threads-corrections"), "db.sqlite"))))
  )
})

interface Split {
  readonly id: string
  readonly fork: string
  readonly slot: string
  readonly seq: number
  readonly members: ReadonlyArray<string>
}

/**
 * The lineage rule: fork `g` sees split X when its lineage reaches X's branch with X's seq at
 * most the bound there (itself unbounded, a parent up to when the child was made), and it's in
 * the member whose fork its lineage passes through, else in the continuing one.
 */
const oracle = (
  forks: ReadonlyMap<string, ForkRow & { readonly branched_at: number }>,
  splits: ReadonlyArray<Split>,
  g: string
) => {
  const lineage: Array<{ fork: string; bound: number }> = [{ fork: g, bound: Infinity }]
  for (let f = forks.get(g)!; f.parent_fork_id !== null; f = forks.get(f.parent_fork_id)!)
    lineage.push({ fork: f.parent_fork_id, bound: f.branched_at })
  return splits.flatMap((x) => {
    const at = lineage.find((entry) => entry.fork === x.fork)
    if (at === undefined || x.seq > at.bound) return []
    const member = x.members.findIndex((m) => lineage.some((entry) => entry.fork === m))
    return [`${g} ${x.id} ${member + 1}`]
  })
}

const compare = (sql: SqlClient.SqlClient, splits: ReadonlyArray<Split>) =>
  Effect.gen(function* () {
    const rows = yield* sql<ForkRow & { readonly branched_at: number }>`SELECT * FROM forks WHERE chat_id = ${CHAT}`
    const forks = new Map(rows.map((row) => [row.id, row]))
    const expected = rows.flatMap((row) => oracle(forks, splits, row.id)).sort()
    const found = (yield* threadCandidates(
      sql,
      rows.map((row) => row.id)
    ))
      .map((c) => `${c.forkId} ${c.splitId} ${c.ordinal}`)
      .sort()
    assert.deepStrictEqual(found, expected)
    return { forks: rows.length, pairs: expected.length }
  })

/** A random tree: forks made from any fork, splits in any fork (threads included) at any message. */
const scenario = (seed: number, paused: boolean) => {
  const file = join(tempDir(`threads-tree-${seed}`), "db.sqlite")
  return Effect.gen(function* () {
    const sql = yield* setup
    if (paused) yield* sql`INSERT INTO fork_label_pause VALUES (1)`
    const next = random(seed)
    const forks: Array<string> = [CHAT]
    const splits: Array<Split> = []
    for (let step = 0; step < 160; step++) {
      const fork = forks[next(forks.length)]!
      const slot = SLOTS[next(SLOTS.length)]!
      if (next(5) === 0) {
        const made = yield* split(sql, fork, slot, 2 + next(3))
        const [row] = yield* sql<{ seq: number }>`SELECT seq FROM thread_splits WHERE id = ${made.id}`
        splits.push({ id: made.id, fork, slot, seq: row!.seq, members: made.members })
        forks.push(...made.members)
      } else forks.push(yield* child(sql, fork, slot))
    }
    if (!paused) yield* compare(sql, splits)
    const db = new DatabaseSync(file)
    try {
      db.exec("PRAGMA foreign_keys = ON; BEGIN")
      const rebuilt = rebuildForkLabels(db, CHAT)
      assert.strictEqual(rebuilt.splits, splits.length)
      if (paused) db.exec("DELETE FROM fork_label_pause")
      db.exec("COMMIT")
    } finally {
      db.close()
    }
    const after = yield* compare(sql, splits)
    // Writes after a rebuild keep to the rule.
    for (let step = 0; step < 40; step++) {
      const fork = forks[next(forks.length)]!
      if (next(3) === 0) {
        const made = yield* split(sql, fork, SLOTS[next(SLOTS.length)]!, 2)
        const [row] = yield* sql<{ seq: number }>`SELECT seq FROM thread_splits WHERE id = ${made.id}`
        splits.push({ id: made.id, fork, slot: "", seq: row!.seq, members: made.members })
        forks.push(...made.members)
      } else forks.push(yield* child(sql, fork, SLOTS[next(SLOTS.length)]!))
    }
    yield* compare(sql, splits)
    assert.isTrue(after.pairs > splits.length / 2, "the scenario holds splits forks are in")
  }).pipe(Effect.provide(writerConnection(file)))
}

describe("which thread a fork is in", () => {
  for (const seed of [1, 2, 3, 4, 5])
    it.effect(`matches the lineage rule over random fork trees, seed ${seed}`, () => scenario(seed, false))
  it.effect("matches it after a paused rebuild, as an import loads", () => scenario(9, true))

  it("orders places innermost first and shows a split while two of its threads have a live fork", () => {
    const candidates = [
      { forkId: "g", splitId: "a", slotId: "s1", depth: 1, ordinal: 1 },
      { forkId: "g", splitId: "b", slotId: "s3", depth: 3, ordinal: 0 },
      { forkId: "g", splitId: "c", slotId: "s3", depth: 3, ordinal: 2 },
      { forkId: "g", splitId: "d", slotId: "off", depth: 2, ordinal: 1 },
      { forkId: "h", splitId: "a", slotId: "s1", depth: 1, ordinal: 0 }
    ]
    const g = placesOf(candidates, "g", (slot) => slot !== "off")
    assert.deepStrictEqual(g, [
      { splitId: "c", ordinal: 2 },
      { splitId: "b", ordinal: 0 },
      { splitId: "a", ordinal: 1 }
    ])
    const h = placesOf(candidates, "h", () => true)
    assert.deepStrictEqual([...shownSplits([g, h])].sort(), ["a"])
    assert.deepStrictEqual([...shownSplits([g])], [])
  })
})
