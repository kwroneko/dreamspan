// Fork labels against the lineage rule (spec/FORK-COST.md §4, db/forkLabels.ts): random fork
// trees with ties, a chain of 300, a fan-out of 600 and mixed shapes, each written through the
// real helpers (insertFork, writeOverride with its in-place updates, recordReduction, fork
// events), then every lookup, event and history reduction compared, in every fork, with the
// lineage rule computed here from the rows themselves: a fork sees its own rows, its parent's
// with seq up to when it was made, and so on up; the nearest entry with a row wins, its newest.
// Then the same after `rebuildForkLabels` recomputes everything from seqs. Synthetic data only.
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { writerConnection } from "../src/db/connection.ts"
import { forkLabelSchema, pointAtSql, rebuildForkLabels } from "../src/db/forkLabels.ts"
import { forkImportSlot } from "../src/db/stImportFork.ts"
import { effectiveOverride, eventApplies, insertFork, nextSeq, writeOverride } from "../src/db/forkState.ts"
import { historyRevision, recordReduction } from "../src/db/historyChanges.ts"
import { migrations } from "../src/db/migrations.ts"
import type { ForkRow } from "../src/db/rows.ts"
import { tempDir } from "./support/tempDir.ts"

const CHAT = "c"
const SLOTS = ["r", "s1", "s2", "s3"] as const
const KEYS = ["k0", "k1", "k2", "k3", "k4", "k5"]
const KINDS = [
  "select",
  "replace",
  "star",
  "picker_hide",
  "delete_slot",
  "delete_version",
  "hide",
  "hide_range",
  "suppress_event",
  "image_exclude",
  "summary_revision",
  "summary_choice",
  "summary_rerun",
  "summary_superseded",
  "insert"
] as const
type Kind = (typeof KINDS)[number]
const SUMMARIES = ["summary0", "summary1"]
const RANGES = ["range0", "range1"]

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
  for (const [depth, id] of SLOTS.entries())
    yield* Effect.gen(function* () {
      yield* sql`INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at, authoring_fork_id)
        VALUES (${`v-${id}`}, ${id}, 0, 'complete', 'human', 'x', 'verbatim', 'user_written', 1, 1, ${CHAT} )`
      yield* sql`INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, created_at)
        VALUES (${id}, ${CHAT}, ${depth === 0 ? null : SLOTS[depth - 1]!}, ${depth}, ${`v-${id}`}, 1)`
    }).pipe(sql.withTransaction)
  yield* sql`UPDATE forks SET tip_slot_id = 's3' WHERE id = ${CHAT}`
  for (const id of SLOTS) {
    for (let ordinal = 1; ordinal < 20; ordinal++)
      yield* sql`INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at, authoring_fork_id)
        VALUES (${`swipe-${id}-${ordinal}`}, ${id}, ${ordinal}, 'complete', 'human', 'swipe', 'verbatim', 'user_written', 1, 1, ${CHAT} )`
    yield* sql`INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at, fork_id, source_version_id, authoring_fork_id)
      VALUES (${`copy-${id}`}, ${id}, 20, 'complete', 'human', 'copy', 'verbatim', 'edited', 1, 1, ${CHAT}, ${`v-${id}`}, ${CHAT} )`
  }
  yield* Effect.gen(function* () {
    yield* sql`INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at, authoring_fork_id)
      VALUES ('v-inserted', 'inserted', 0, 'complete', 'human', 'insert', 'verbatim', 'user_written', 1, 1, ${CHAT} )`
    yield* sql`INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, inserted, created_at)
      VALUES ('inserted', ${CHAT}, 'r', 1, 'v-inserted', 1, 1)`
    for (const id of SUMMARIES) {
      yield* sql`INSERT INTO summary_revisions (id, summary_id, content, token_count, origin, created_at)
        VALUES (${`revision-${id}`}, ${id}, 'summary', 1, 'user', 1)`
      yield* sql`INSERT INTO summaries (id, chat_id, level, selected_revision_id, first_slot_id, last_slot_id, slot_count, created_at)
        VALUES (${id}, ${CHAT}, 1, ${`revision-${id}`}, 'r', 's3', 4, 1)`
      yield* sql`INSERT INTO summary_reruns (id, chat_id, summary_id, requested_at) VALUES (${`rerun-${id}`}, ${CHAT}, ${id}, 1)`
    }
    for (const id of RANGES) {
      yield* sql`INSERT INTO lcm_enable_runs (id, chat_id, payload_json, published) VALUES (${id}, ${CHAT}, '{}', 1)`
      for (const [ordinal, slot] of SLOTS.entries())
        yield* sql`INSERT INTO lcm_enable_slots (run_id, ordinal, slot_id, version_id, amend_count, shown)
          VALUES (${id}, ${ordinal}, ${slot}, ${`v-${slot}`}, 0, ${slot === "s3" ? 0 : 1})`
    }
  }).pipe(sql.withTransaction)
  const seq = yield* nextSeq(sql, CHAT)
  yield* sql`INSERT INTO state_events (id, chat_id, slot_id, seq, key, value_json, origin, created_at, fork_id, fork_seq)
    VALUES ('initial-event', ${CHAT}, 's1', ${seq}, 'var.set', '{}', 'user', 1, ${CHAT}, ${seq})`
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
      write: (fork, kind, target, flag) => {
        if (kind === "hide_range")
          return Effect.gen(function* () {
            const seq = yield* nextSeq(sql, CHAT)
            yield* sql`INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, flag)
            VALUES (${`range-${seq}`}, ${CHAT}, ${fork}, ${seq}, 'hide_range', ${target}, 0)`
          })
        const slot =
          kind === "select" || kind === "hide" || kind === "delete_slot"
            ? target
            : ["replace", "star", "picker_hide", "delete_version"].includes(kind)
              ? target.slice(2)
              : kind.startsWith("summary_") || kind === "insert"
                ? "r"
                : kind === "suppress_event"
                  ? "s1"
                  : null
        const value =
          kind === "select"
            ? flag
              ? `swipe-${target}-19`
              : `v-${target}`
            : kind === "replace"
              ? flag
                ? `copy-${slot}`
                : null
              : kind === "summary_revision"
                ? `revision-${target}`
                : kind === "summary_choice" || kind === "summary_superseded"
                  ? SUMMARIES[flag]!
                  : kind === "summary_rerun" && flag
                    ? `rerun-${target}`
                    : null
        return Effect.asVoid(
          writeOverride(sql, { id: fork, chatId: CHAT }, { kind, targetId: target, slotId: slot, valueId: value, flag })
        )
      },
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

const targetsOf = (kind: Kind): ReadonlyArray<string> => {
  if (kind === "select" || kind === "hide" || kind === "delete_slot") return SLOTS
  if (["replace", "star", "picker_hide", "delete_version"].includes(kind)) return SLOTS.map((s) => `v-${s}`)
  if (kind.startsWith("summary_")) return SUMMARIES
  if (kind === "hide_range") return RANGES
  if (kind === "insert") return ["inserted"]
  if (kind === "suppress_event") return ["initial-event"]
  return KEYS
}

/** Every fork's lookups, events and history as the database answers them, and as the lineage rule does. */
const compare = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const forks = yield* sql<{ id: string; parent: string | null; at: number }>`
      SELECT id, parent_fork_id AS parent, branched_at AS at FROM forks WHERE chat_id = ${CHAT}`
    const rows = yield* sql<{
      id: string
      fork: string
      kind: string
      target: string
      seq: number
      flag: number | null
    }>`
      SELECT id, fork_id AS fork, kind, target_id AS target, seq, flag FROM fork_overrides WHERE chat_id = ${CHAT}`
    const events = yield* sql<{ id: string; fork: string; seq: number }>`
      SELECT id, fork_id AS fork, fork_seq AS seq FROM state_events WHERE chat_id = ${CHAT} AND fork_id IS NOT NULL`
    const changes = yield* sql<{ fork: string; seq: number; revision: number }>`
      SELECT fork_id AS fork, seq, revision FROM history_changes WHERE chat_id = ${CHAT} AND fork_id <> ''`
    const index = new Map<string, typeof rows>()
    for (const row of [...rows].sort((a, b) => b.seq - a.seq)) {
      const key = `${row.fork}\0${row.kind}\0${row.target}`
      const list = index.get(key) ?? []
      index.set(key, [...list, row])
    }
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
      const effective = (kind: string, target: string) => {
        for (const [entry, bound] of entries) {
          const keys = [
            [kind, target],
            ...(kind === "hide" && target !== "s3" ? RANGES.map((r) => ["hide_range", r]) : [])
          ]
          const own = keys
            .flatMap(([k, t]) => index.get(`${entry}\0${k}\0${t}`)?.find((r) => r.seq <= bound) ?? [])
            .sort((a, b) => b.seq - a.seq)[0]
          if (own !== undefined) return own
        }
        return undefined
      }
      for (const kind of KINDS) {
        const got = yield* sql<{ target: string; id: string | null }>`
          SELECT t.value AS target, ${effectiveOverride(sql, kind, fork.id, "t.value")} AS id
          FROM json_each(${JSON.stringify(targetsOf(kind))}) t`
        for (const { target, id } of got) {
          const want = effective(kind, target)?.id ?? null
          lookups++
          if (id !== want) mismatches.push(`${fork.id} ${kind} ${target}: ${id} != ${want}`)
        }
      }
      const visible = (yield* sql<{ id: string }>`
        SELECT e.id FROM state_events e WHERE e.chat_id = ${CHAT} AND e.fork_id IS NOT NULL
          AND ${eventApplies(sql, fork.id, "e")}`).map((e) => e.id)
      const wantEvents = events
        .filter((e) => sees(e.fork, e.seq) && effective("suppress_event", e.id)?.flag !== 1)
        .map((e) => e.id)
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
const check = (name: string, steps: (op: Ops) => Effect.Effect<void, unknown>, paused = false) => {
  const file = join(tempDir(`fork-labels-${name}`), "db.sqlite")
  return Effect.gen(function* () {
    const sql = yield* setup
    if (paused) yield* sql`INSERT INTO fork_label_pause VALUES (1)`
    const forks = yield* build(sql, steps)
    const live = paused ? null : yield* compare(sql)
    if (live) assert.deepStrictEqual(live.mismatches, [], `${name}: triggers`)
    const db = new DatabaseSync(file)
    try {
      db.exec("PRAGMA foreign_keys = ON; BEGIN")
      rebuildForkLabels(db, CHAT)
      if (paused) db.exec("DELETE FROM fork_label_pause WHERE paused = 1")
      db.exec("COMMIT")
    } finally {
      db.close()
    }
    const rebuilt = yield* compare(sql)
    assert.deepStrictEqual(rebuilt.mismatches, [], `${name}: rebuilt`)
    // Rebuilding must also leave the steps ready for subsequent in-place writes and forks.
    const next = random(123)
    yield* build(sql, (op) =>
      Effect.gen(function* () {
        for (let i = 0; i < 20; i++) {
          const fork = pick(next, forks)
          yield* writeSome(op, next, fork)
          const child = yield* op.fork(fork)
          yield* writeSome(op, next, fork)
          yield* writeSome(op, next, child)
        }
      })
    )
    assert.deepStrictEqual((yield* compare(sql)).mismatches, [], `${name}: writes after rebuild`)
    console.log(
      `fork labels, ${name}: ${rebuilt.forks} forks, ${rebuilt.lookups} lookups, ${rebuilt.events} event checks`
    )
    return rebuilt
  }).pipe(Effect.provide(writerConnection(file)))
}

const pick = <T>(next: (n: number) => number, xs: ReadonlyArray<T>) => xs[Math.floor(next(xs.length))]!
const kindOf = (next: (n: number) => number): Kind => pick(next, KINDS)
const writeSome = (op: Ops, next: (n: number) => number, fork: string) => {
  const kind = kindOf(next)
  return op.write(fork, kind, pick(next, targetsOf(kind)), next(2) < 1 ? 1 : 0)
}

describe("fork labels", () => {
  it.effect("a cancelled paused load rolls back its pause, forks and writes", () => {
    const file = join(tempDir("fork-labels-cancel"), "db.sqlite")
    return Effect.gen(function* () {
      const sql = yield* setup
      const cancelled = yield* Effect.exit(
        Effect.gen(function* () {
          yield* sql`INSERT INTO fork_label_pause VALUES (1)`
          yield* build(sql, (op) =>
            Effect.gen(function* () {
              const fork = yield* op.fork(CHAT)
              yield* op.write(fork, "delete_slot", "s1", 1)
              yield* op.event(fork)
              yield* op.reduce(fork, "s1")
            })
          )
          return yield* Effect.fail("cancel")
        }).pipe(sql.withTransaction)
      )
      assert.isTrue(Exit.isFailure(cancelled))
      const [remaining] = yield* sql<{ pauses: number; forks: number; overrides: number }>`SELECT
        (SELECT count(*) FROM fork_label_pause) AS pauses, (SELECT count(*) FROM forks) AS forks,
        (SELECT count(*) FROM fork_overrides) AS overrides`
      assert.deepStrictEqual(remaining, { pauses: 0, forks: 1, overrides: 0 })
      yield* build(sql, (op) =>
        Effect.gen(function* () {
          const child = yield* op.fork(CHAT)
          yield* op.write(CHAT, "hide", "s1", 1)
          yield* op.write(child, "hide", "s1", 0)
          yield* op.event(child)
        })
      )
      assert.deepStrictEqual((yield* compare(sql)).mismatches, [])
    }).pipe(Effect.provide(writerConnection(file)))
  })

  it("rebuilds more than 65,759 children with the same encoding as the triggers", () => {
    // Only the label subsystem here: avoid 65,760 copies of unrelated domain fixtures.
    const db = new DatabaseSync(":memory:")
    try {
      db.exec(`PRAGMA foreign_keys=ON;
        CREATE TABLE chats(id TEXT PRIMARY KEY);
        CREATE TABLE forks(id TEXT PRIMARY KEY, chat_id TEXT, parent_fork_id TEXT, branched_at INTEGER);
        CREATE INDEX forks_parent ON forks(parent_fork_id, branched_at);
        CREATE TABLE fork_overrides(id TEXT, chat_id TEXT, fork_id TEXT, kind TEXT, target_id TEXT, seq INTEGER);
        CREATE TABLE state_events(id TEXT, chat_id TEXT, fork_id TEXT, fork_seq INTEGER, fork_label BLOB);
        CREATE TABLE history_changes(slot_id TEXT, chat_id TEXT, fork_id TEXT, seq INTEGER, label BLOB);
        CREATE TABLE thread_splits(id TEXT, chat_id TEXT, fork_id TEXT, seq INTEGER, fork_label BLOB);`)
      for (const statement of forkLabelSchema) db.exec(statement)
      db.exec(
        "BEGIN; INSERT INTO chats VALUES ('c'); INSERT INTO forks VALUES ('c', 'c', NULL, 0); INSERT INTO fork_label_pause VALUES (1)"
      )
      const child = db.prepare("INSERT INTO forks VALUES (?, 'c', 'c', ?)")
      for (let i = 0; i < 65760; i++) child.run(`child-${i}`, i)
      rebuildForkLabels(db, CHAT)
      const order = db
        .prepare(
          `SELECT count(*) AS n FROM fork_labels c JOIN fork_labels p ON p.fork_id = 'c'
        WHERE c.fork_id <> 'c' AND c.label_end >= p.point`
        )
        .get() as { n: number }
      assert.strictEqual(order.n, 0, "every child's range ends before its parent's current point")
      const same = db
        .prepare(`SELECT point = ${pointAtSql("'c'", "65761")} AS same FROM fork_labels WHERE fork_id = 'c'`)
        .get() as { same: number }
      assert.strictEqual(same.same, 1, "SQL and rebuild encode the same epoch")
      // A pause owned by the caller survives the rebuild, until the transaction commits.
      assert.strictEqual((db.prepare("SELECT count(*) AS n FROM fork_label_pause").get() as { n: number }).n, 1)
      db.exec("DELETE FROM fork_label_pause; COMMIT")
    } finally {
      db.close()
    }
  })

  it.effect("an interrupted import copies an event's frozen label after its fork has children", () => {
    const file = join(tempDir("fork-labels-import-copy"), "db.sqlite")
    return Effect.gen(function* () {
      const sql = yield* setup
      yield* build(sql, (op) =>
        Effect.gen(function* () {
          yield* op.event(CHAT)
          yield* op.fork(CHAT)
          const copy = yield* forkImportSlot(sql, "s1", "r", CHAT)
          const events = yield* sql<{ label: string }>`SELECT hex(fork_label) AS label FROM state_events
            WHERE slot_id IN ('s1', ${copy}) ORDER BY slot_id`
          assert.strictEqual(events.length, 4)
          assert.isTrue(events.every((e) => e.label === events[0]!.label))
        })
      )
      assert.deepStrictEqual((yield* compare(sql)).mismatches, [])
    }).pipe(Effect.provide(writerConnection(file)))
  })

  it.effect("epochs beyond the two-byte boundary stay ordered and prefix-free", () => {
    const file = join(tempDir("fork-labels-encoding"), "db.sqlite")
    return Effect.gen(function* () {
      const sql = yield* setup
      // Jump to the boundary without creating 65,759 otherwise identical children.
      yield* sql`UPDATE fork_labels SET epoch = 65759, point = unhex('F0FFFF') WHERE fork_id = ${CHAT}`
      yield* build(sql, (op) =>
        Effect.gen(function* () {
          const child = yield* op.fork(CHAT)
          const [order] = yield* sql<{
            ordered: number
          }>`SELECT c.point < c.label_end AND c.label_end < p.point AS ordered
            FROM fork_labels c JOIN fork_labels p ON p.fork_id = ${CHAT} WHERE c.fork_id = ${child}`
          assert.strictEqual(order!.ordered, 1)
          yield* op.write(CHAT, "image_exclude", "k0", 1)
          assert.deepStrictEqual((yield* compare(sql)).mismatches, [])
        })
      )
    }).pipe(Effect.provide(writerConnection(file)))
  })

  it.effect(
    "random fork trees with ties, in-place updates, events and reductions match the lineage rule",
    () =>
      Effect.gen(function* () {
        for (let seed = 1; seed <= 6; seed++) {
          const next = random(seed * 7919)
          yield* check(
            `random-${seed}`,
            (op) =>
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
              }),
            seed === 6
          )
        }
      }),
    120_000
  )

  it.effect(
    "a chain of 300 and a fan-out of 600, written at every step, match the lineage rule",
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
            for (let i = 0; i < 600; i++) {
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
