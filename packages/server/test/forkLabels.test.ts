// Fork labels against the lineage rule (spec/FORK-COST.md §4, db/forkLabels.ts): random fork
// trees with ties, a chain of 300, a fan-out of 300 and mixed shapes, each written through the
// real helpers (insertFork, writeOverride with its in-place updates, recordReduction, fork
// events), then every lookup, event and history reduction compared, in every fork, with the
// lineage rule computed here from the rows themselves: a fork sees its own rows, its parent's
// with seq up to when it was made, and so on up; the nearest entry with a row wins, its newest.
// Then the same after `rebuildForkLabels` recomputes everything from seqs. Synthetic data only.
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { writerConnection } from "../src/db/connection.ts"
import { rebuildForkLabels } from "../src/db/forkLabels.ts"
import { effectiveOverride, eventApplies, insertFork, nextSeq, writeOverride } from "../src/db/forkState.ts"
import { historyRevision, recordReduction } from "../src/db/historyChanges.ts"
import { migrations } from "../src/db/migrations.ts"
import type { ForkRow } from "../src/db/rows.ts"
import { tempDir } from "./support/tempDir.ts"

const CHAT = "c"
const SLOTS = ["r", "s1", "s2", "s3"] as const
const KEYS = ["k0", "k1", "k2", "k3", "k4", "k5"]
type Kind = "image_exclude" | "delete_slot"

const random = (seed: number) => {
  let a = seed >>> 0
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * n
  }
}

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
  yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'u', 'admin', 1)`
  yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES (${CHAT}, 'u', 'rp', 'active', 1)`
  yield* sql`INSERT INTO lanes (id, chat_id, name, created_at) VALUES ('l', ${CHAT}, 'main', 1)`
  for (const [depth, id] of SLOTS.entries())
    yield* Effect.gen(function* () {
      yield* sql`INSERT INTO versions (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at)
        VALUES (${`v-${id}`}, ${id}, 0, 'complete', 'human', 'x', 'verbatim', 'user_written', 1, 1)`
      yield* sql`INSERT INTO slots (id, chat_id, lane_id, parent_slot_id, depth, selected_version_id, created_at)
        VALUES (${id}, ${CHAT}, 'l', ${depth === 0 ? null : SLOTS[depth - 1]!}, ${depth}, ${`v-${id}`}, 1)`
    }).pipe(sql.withTransaction)
  yield* sql`UPDATE forks SET tip_slot_id = 's3' WHERE id = ${CHAT}`
  return sql
})

/** Writes a scenario's operations through the real helpers; `next` picks. */
const build = (sql: SqlClient.SqlClient, steps: (op: Ops) => Effect.Effect<void, unknown>) =>
  Effect.gen(function* () {
    const forks: Array<string> = [CHAT]
    const ops: Ops = {
      forks,
      fork: (parent) =>
        Effect.gen(function* () {
          const [row] = yield* sql<ForkRow>`SELECT * FROM forks WHERE id = ${parent}`
          const made = yield* insertFork(sql, { chatId: CHAT, parent: row!, baseSlotId: "s3", tipSlotId: "s3", at: 1 })
          forks.push(made.id)
          return made.id
        }),
      write: (fork, kind, target, flag) =>
        Effect.asVoid(
          writeOverride(
            sql,
            { id: fork, chatId: CHAT },
            { kind, targetId: target, slotId: kind === "delete_slot" ? target : null, valueId: null, flag }
          )
        ),
      event: (fork) =>
        Effect.gen(function* () {
          const seq = yield* nextSeq(sql, CHAT)
          yield* sql`INSERT INTO state_events (id, chat_id, slot_id, seq, key, value_json, origin, created_at, fork_id, fork_seq)
            VALUES (${`e-${seq}`}, ${CHAT}, 's1', ${seq}, 'var.set', '{}', 'user', 1, ${fork}, ${seq})`
        }),
      reduce: (fork, slot) => recordReduction(sql, slot, fork),
      tick: Effect.asVoid(nextSeq(sql, CHAT))
    }
    yield* steps(ops).pipe(sql.withTransaction)
    return forks
  })

interface Ops {
  readonly forks: ReadonlyArray<string>
  readonly fork: (parent: string) => Effect.Effect<string, unknown>
  readonly write: (fork: string, kind: Kind, target: string, flag: 0 | 1) => Effect.Effect<void, unknown>
  readonly event: (fork: string) => Effect.Effect<void, unknown>
  readonly reduce: (fork: string, slot: string) => Effect.Effect<void, unknown>
  readonly tick: Effect.Effect<void, unknown>
}

const targetsOf = (kind: Kind): ReadonlyArray<string> => (kind === "delete_slot" ? SLOTS : KEYS)

/** Every fork's lookups, events and history as the database answers them, and as the lineage rule does. */
const compare = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const forks = yield* sql<{ id: string; parent: string | null; at: number }>`
      SELECT id, parent_fork_id AS parent, branched_at AS at FROM forks WHERE chat_id = ${CHAT}`
    const rows = yield* sql<{ id: string; fork: string; kind: string; target: string; seq: number }>`
      SELECT id, fork_id AS fork, kind, target_id AS target, seq FROM fork_overrides WHERE chat_id = ${CHAT}`
    const events = yield* sql<{ id: string; fork: string; seq: number }>`
      SELECT id, fork_id AS fork, fork_seq AS seq FROM state_events WHERE chat_id = ${CHAT} AND fork_id IS NOT NULL`
    const changes = yield* sql<{ fork: string; seq: number; revision: number }>`
      SELECT fork_id AS fork, seq, revision FROM history_changes WHERE chat_id = ${CHAT} AND fork_id <> ''`
    const byId = new Map(forks.map((f) => [f.id, f]))
    const lineage = (id: string) => {
      const out: Array<[string, number]> = []
      let at = Number.MAX_SAFE_INTEGER
      for (let f = byId.get(id); f !== undefined; f = f.parent === null ? undefined : byId.get(f.parent)) {
        out.push([f.id, at])
        at = f.at
      }
      return out
    }
    let lookups = 0
    let mismatches: Array<string> = []
    for (const fork of forks) {
      const entries = lineage(fork.id)
      const sees = (writer: string, seq: number) => entries.some(([id, bound]) => id === writer && seq <= bound)
      for (const kind of ["image_exclude", "delete_slot"] as const) {
        const got = yield* sql<{ target: string; id: string | null }>`
          SELECT t.value AS target, ${effectiveOverride(sql, kind, fork.id, "t.value")} AS id
          FROM json_each(${JSON.stringify(targetsOf(kind))}) t`
        for (const { target, id } of got) {
          let want: string | null = null
          for (const [entry, bound] of entries) {
            const own = rows
              .filter((r) => r.fork === entry && r.kind === kind && r.target === target && r.seq <= bound)
              .sort((a, b) => b.seq - a.seq)[0]
            if (own !== undefined) {
              want = own.id
              break
            }
          }
          lookups++
          if (id !== want) mismatches.push(`${fork.id} ${kind} ${target}: ${id} != ${want}`)
        }
      }
      const visible = (yield* sql<{ id: string }>`
        SELECT e.id FROM state_events e WHERE e.chat_id = ${CHAT} AND e.fork_id IS NOT NULL
          AND ${eventApplies(sql, fork.id, "e")}`).map((e) => e.id)
      const wantEvents = events.filter((e) => sees(e.fork, e.seq)).map((e) => e.id)
      if (JSON.stringify(visible.sort()) !== JSON.stringify(wantEvents.sort()))
        mismatches.push(`${fork.id} events: ${visible.length} != ${wantEvents.length}`)
      const [revision] = yield* historyRevision(sql, "u", CHAT, "s3", 100, fork.id)
      const wantRevision = changes.filter((c) => sees(c.fork, c.seq)).reduce((n, c) => n + c.revision, 0)
      if (revision!.revision !== wantRevision)
        mismatches.push(`${fork.id} history: ${revision!.revision} != ${wantRevision}`)
      if (mismatches.length > 20) break
    }
    mismatches = mismatches.slice(0, 20)
    return { forks: forks.length, lookups, events: events.length * forks.length, mismatches }
  })

/** Builds the scenario, compares, rebuilds every label and step from seqs, compares again. */
const check = (name: string, steps: (op: Ops) => Effect.Effect<void, unknown>) => {
  const file = join(tempDir(`fork-labels-${name}`), "db.sqlite")
  return Effect.gen(function* () {
    const sql = yield* setup
    yield* build(sql, steps)
    const live = yield* compare(sql)
    assert.deepStrictEqual(live.mismatches, [], `${name}: triggers`)
    const db = new DatabaseSync(file)
    try {
      db.exec("PRAGMA foreign_keys = ON; BEGIN")
      rebuildForkLabels(db, CHAT)
      db.exec("COMMIT")
    } finally {
      db.close()
    }
    const rebuilt = yield* compare(sql)
    assert.deepStrictEqual(rebuilt.mismatches, [], `${name}: rebuilt`)
    console.log(`fork labels, ${name}: ${live.forks} forks, ${live.lookups} lookups, ${live.events} event checks`)
    return live
  }).pipe(Effect.provide(writerConnection(file)))
}

const pick = <T>(next: (n: number) => number, xs: ReadonlyArray<T>) => xs[Math.floor(next(xs.length))]!
const kindOf = (next: (n: number) => number): Kind => (next(3) < 2 ? "image_exclude" : "delete_slot")
const writeSome = (op: Ops, next: (n: number) => number, fork: string) => {
  const kind = kindOf(next)
  return op.write(fork, kind, pick(next, targetsOf(kind)), next(2) < 1 ? 1 : 0)
}

describe("fork labels", () => {
  it.effect(
    "random fork trees with ties, in-place updates, events and reductions match the lineage rule",
    () =>
      Effect.gen(function* () {
        for (let seed = 1; seed <= 6; seed++) {
          const next = random(seed * 7919)
          yield* check(`random-${seed}`, (op) =>
            Effect.gen(function* () {
              for (let step = 0; step < 400; step++) {
                const fork = pick(next, op.forks)
                const roll = next(100)
                if (roll < 25) yield* op.fork(fork)
                else if (roll < 30) {
                  // Ties: forks made with nothing written between them.
                  yield* op.fork(fork)
                  yield* op.fork(fork)
                } else if (roll < 75) yield* writeSome(op, next, fork)
                else if (roll < 85) yield* op.event(fork)
                else if (roll < 95) yield* op.reduce(fork, pick(next, SLOTS))
                else yield* op.tick
              }
            })
          )
        }
      }),
    120_000
  )

  it.effect(
    "a chain of 300 and a fan-out of 300, written at every step, match the lineage rule",
    () =>
      Effect.gen(function* () {
        const chain = random(31)
        yield* check("chain", (op) =>
          Effect.gen(function* () {
            let tip = op.forks[0]!
            for (let i = 0; i < 300; i++) {
              // A write before, in the parent and in an ancestor, and some in-place again.
              yield* writeSome(op, chain, tip)
              if (i % 3 === 0) yield* writeSome(op, chain, pick(chain, op.forks))
              if (i % 7 === 0) yield* op.event(pick(chain, op.forks))
              if (i % 5 === 0) yield* op.reduce(pick(chain, op.forks), pick(chain, SLOTS))
              tip = yield* op.fork(tip)
              yield* writeSome(op, chain, tip)
            }
          })
        )
        const fan = random(37)
        yield* check("fan-out", (op) =>
          Effect.gen(function* () {
            const root = op.forks[0]!
            for (let i = 0; i < 300; i++) {
              yield* writeSome(op, fan, root)
              const child = yield* op.fork(root)
              if (i % 2 === 0) yield* writeSome(op, fan, child)
              if (i % 11 === 0) yield* op.event(root)
              if (i % 13 === 0) yield* op.reduce(root, pick(fan, SLOTS))
              // Grandchildren of earlier children, made after their parents wrote again.
              if (i % 17 === 0) yield* op.fork(pick(fan, op.forks))
            }
          })
        )
      }),
    240_000
  )

  it.effect("making a fork writes its row and its label, and touches nothing else", () =>
    Effect.gen(function* () {
      const file = join(tempDir("fork-labels-cost"), "db.sqlite")
      yield* Effect.gen(function* () {
        const sql = yield* setup
        let tip = CHAT
        yield* build(sql, (op) =>
          Effect.gen(function* () {
            for (let i = 0; i < 200; i++) {
              for (const key of KEYS) yield* op.write(tip, "image_exclude", key, 1)
              tip = yield* op.fork(tip)
            }
          })
        )
        const count = sql<{ overrides: number; steps: number; labels: number }>`SELECT
          (SELECT count(*) FROM fork_overrides) AS overrides, (SELECT count(*) FROM fork_steps) AS steps,
          (SELECT count(*) FROM fork_labels) AS labels`
        const [before] = yield* count
        const [parent] = yield* sql<ForkRow>`SELECT * FROM forks WHERE id = ${tip}`
        yield* insertFork(sql, { chatId: CHAT, parent: parent!, baseSlotId: "s3", tipSlotId: "s3", at: 1 })
        const [after] = yield* count
        assert.deepStrictEqual(after, { ...before!, labels: before!.labels + 1 })
        // Labels grow by one byte per level of genealogy.
        const [deepest] = yield* sql<{ n: number }>`SELECT max(length(point)) AS n FROM fork_labels`
        assert.strictEqual(deepest!.n, 202)
      }).pipe(Effect.provide(writerConnection(file)))
    })
  )
})
