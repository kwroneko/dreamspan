// Paths read by chain segment at scale (spec/FORK-INDEPENDENCE-DELTA.md §3, implementation
// units 1, 3 and 4): paging back through a 100,000-slot path with 200 branch points, and the
// rows a window and StateEventsAt visit, which mustn't grow with the chat's length. The chat has
// 200 forks, lineages 40 deep, 20,000 selection overrides, 10,000 stars and the chat's first
// fork's copies of its last messages, so a window read in a fork mustn't grow with those
// either. Rows are counted, not timed: a clock fails on a loaded host.
import { DatabaseSync } from "node:sqlite"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { type ChatId, type ForkId, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { SqlClient, type Statement } from "effect/sql"
import { databaseFile } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { pathWindow, stateEventsOnPath } from "../src/db/reads.ts"
import { tempDir } from "./support/tempDir.ts"

/** Branch points: below each of these path depths, the path takes the second child. */
const BRANCHES = Array.from({ length: 200 }, (_, i) => 5 * (i + 1))

/** Forks: a chain this deep from the chat's first, the rest hanging off it, each with this many selections. */
const LINEAGE_DEPTH = 40
const FORKS = 200
const OVERRIDES_PER_FORK = 100
/** Stars each fork sets, on the message's own versions at depths spread over the first 1,000. */
const STARS_PER_FORK = 50
/** The deepest fork of the chain: its selections near the tip pick the second versions there. */
const DEEP_FORK = `c-${LINEAGE_DEPTH - 1}`
/**
 * The last messages that have a second version (`w-…`), which the deepest fork selects, and a
 * copy of the first (`x-…`) that the chat's first fork shows in its place (an amend).
 */
const ALTERNATES = 10

interface Fixture {
  readonly dataDir: string
  readonly userId: UserId
  readonly chatId: ChatId
  readonly length: number
  /** The chat-wide events: the fixture's three and those the chat was created with. */
  readonly chatWide: number
}

const layer = (dataDir: string) => Database.layer({ dataDir, readers: 1, allowNetworkFs: false, workers: "source" })

/**
 * A chat whose path runs from `p-0` to `p-<length>`. Its 200 branch points are in the first
 * 1,000 depths, so two fixtures of different lengths look the same from any slot above
 * depth 2,000: only the length differs. Each branch point's first child is a side reply,
 * which continues the parent's chain, with a reply of its own; the path's child starts a
 * chain. State events sit every 20 depths up to 1,000, on the side replies (off the path),
 * at the tip, and chat-wide.
 */
const build = (length: number) => {
  const dataDir = tempDir(`path-scale-${length}`)
  return Effect.gen(function* () {
    const writer = yield* Database.Writer
    const user = yield* writer.EnsureUser({ handle: "perf", displayName: "Perf" })
    const chat = yield* writer.CreateChat({
      userId: user.id,
      kind: "rp",
      status: "active",
      title: "Synthetic",
      participants: [],
      greeting: null
    })
    const db = new DatabaseSync(databaseFile(dataDir))
    try {
      const lane = (db.prepare("SELECT id FROM lanes WHERE chat_id = ?").get(chat.id) as { id: string }).id
      db.exec("PRAGMA foreign_keys = ON; BEGIN")
      const version = db.prepare(`INSERT INTO versions
        (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at)
        VALUES (?, ?, 0, 'complete', 'model', 'Synthetic reply', 'verbatim', 'generated', 1, 1)`)
      const slotRow = db.prepare(`INSERT INTO slots
        (id, chat_id, lane_id, parent_slot_id, depth, selected_version_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)`)
      const slot = (id: string, parent: string | null, depth: number) => {
        version.run(`v-${id}`, id)
        slotRow.run(id, chat.id, lane, parent, depth, `v-${id}`)
      }
      let seq = 0
      const event =
        db.prepare(`INSERT INTO state_events (id, chat_id, slot_id, seq, key, value_json, origin, created_at)
        VALUES (?, ?, ?, ?, 'var.set', ?, 'user', 1)`)
      const note = (slotId: string | null, name: string) =>
        event.run(`e-${seq}`, chat.id, slotId, seq++, JSON.stringify({ name, value: name }))
      const branches = new Set(BRANCHES)
      for (let depth = 0; depth <= length; depth++) {
        const parent = depth === 0 ? null : `p-${depth - 1}`
        if (branches.has(depth)) {
          slot(`side-${depth}`, parent, depth)
          slot(`side-${depth}-reply`, `side-${depth}`, depth + 1)
          note(`side-${depth}`, `side ${depth}`)
        }
        slot(`p-${depth}`, parent, depth)
        if (depth <= 1000 && depth % 20 === 0) note(`p-${depth}`, `path ${depth}`)
      }
      note(`p-${length}`, "tip")
      for (const name of ["one", "two", "three"]) note(null, name)
      db.prepare("UPDATE chats SET active_leaf_slot_id = ? WHERE id = ?").run(`p-${length}`, chat.id)

      // Forks and their selections, the same in every fixture relative to the root and to the tip.
      const alternate = db.prepare(`INSERT INTO versions
        (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at)
        VALUES (?, ?, 1, 'complete', 'model', 'Alternate reply', 'verbatim', 'generated', 1, 1)`)
      const copy = db.prepare(`INSERT INTO versions
        (id, slot_id, ordinal, status, writer, content, macro_mode, origin, source_version_id, fork_id, created_at,
          updated_at)
        VALUES (?, ?, 2, 'complete', 'human', 'Amended', 'verbatim', 'edited', ?, ?, 1, 1)`)
      for (let j = 0; j < ALTERNATES; j++) {
        alternate.run(`w-p-${length - j}`, `p-${length - j}`)
        copy.run(`x-p-${length - j}`, `p-${length - j}`, `v-p-${length - j}`, chat.id)
      }
      const forkRow = db.prepare(`INSERT INTO forks (id, chat_id, parent_fork_id, branched_at, created_at, lineage_json)
        VALUES (?, ?, ?, ?, 1, ?)`)
      const override = db.prepare(`INSERT INTO fork_overrides
        (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id)
        VALUES (?, ?, ?, ?, 'select', ?, ?, ?, ?)`)
      const replace = db.prepare(`INSERT INTO fork_overrides
        (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id)
        VALUES (?, ?, ?, ?, 'replace', ?, ?, ?, ?)`)
      const star = db.prepare(`INSERT INTO fork_overrides
        (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, flag)
        VALUES (?, ?, ?, ?, 'star', ?, ?, ?, 1)`)
      let state = 0
      const lineages = new Map<string, Array<[string, number | null]>>([[chat.id, [[chat.id, null]]]])
      const choose = (fork: string, n: number) => {
        for (let k = 0; k < OVERRIDES_PER_FORK; k++) {
          const near = k < ALTERNATES
          const depth = near ? length - k : (k * 7 + n * 13) % 1000
          const value = near && fork === DEEP_FORK ? `w-p-${depth}` : `v-p-${depth}`
          override.run(`o-${fork}-${k}`, chat.id, fork, ++state, `p-${depth}`, `p-${depth}`, depth, value)
        }
        for (let k = 0; k < STARS_PER_FORK; k++) {
          const depth = (k * 11 + n * 17) % 1000
          star.run(`s-${fork}-${k}`, chat.id, fork, ++state, `v-p-${depth}`, `p-${depth}`, depth)
        }
        if (fork === chat.id)
          for (let j = 0; j < ALTERNATES; j++) {
            const depth = length - j
            replace.run(`r-${j}`, chat.id, fork, ++state, `v-p-${depth}`, `p-${depth}`, depth, `x-p-${depth}`)
          }
      }
      const fork = (id: string, parent: string, n: number) => {
        const inherited = lineages.get(parent)!.slice(1)
        const lineage: Array<[string, number | null]> = [[id, null], [parent, state], ...inherited]
        lineages.set(id, lineage)
        forkRow.run(id, chat.id, parent, state, JSON.stringify(lineage))
        choose(id, n)
      }
      choose(chat.id, 0)
      for (let k = 1; k < LINEAGE_DEPTH; k++) fork(`c-${k}`, k === 1 ? chat.id : `c-${k - 1}`, k)
      for (let k = LINEAGE_DEPTH; k < FORKS; k++)
        fork(`f-${k}`, k % 2 ? chat.id : `c-${(k % (LINEAGE_DEPTH - 1)) + 1}`, k)
      db.prepare("UPDATE chats SET state_seq = ? WHERE id = ?").run(state, chat.id)
      db.exec("COMMIT")
      const { n } = db
        .prepare("SELECT count(*) AS n FROM state_events WHERE chat_id = ? AND slot_id IS NULL")
        .get(chat.id) as { n: number }
      return { dataDir, userId: user.id as UserId, chatId: chat.id, length, chatWide: n } satisfies Fixture
    } finally {
      db.close()
    }
  }).pipe(Effect.provide(layer(dataDir)))
}

const fixtures = new Map<number, Promise<Fixture>>()
const fixture = (length: number) =>
  Effect.promise(() => {
    let built = fixtures.get(length)
    if (!built) fixtures.set(length, (built = Effect.runPromise(build(length))))
    return built
  })

/** The statement's SQL and parameters, compiled against the fixture's database. */
const compiled = (f: Fixture, statement: (sql: SqlClient.SqlClient) => Statement.Statement<unknown>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return statement(sql).compile()
  }).pipe(Effect.provide(SqliteClient.layer({ filename: databaseFile(f.dataDir), readonly: true })))

/**
 * Runs a statement with every row read from `slots`, `versions`, `state_events`, `forks` and
 * `fork_overrides` counted:
 * temporary views of the same names shadow the tables and call a counter per row, which
 * keeps their indexes usable. The sibling counts name their index (`INDEXED BY`), which a
 * view can't take, so they read the table itself and go uncounted: they cost an entry's
 * siblings, which this unit doesn't change.
 */
const visits = (f: Fixture, statement: (sql: SqlClient.SqlClient) => Statement.Statement<unknown>) =>
  Effect.gen(function* () {
    const [text, params] = yield* compiled(f, statement)
    const db = new DatabaseSync(databaseFile(f.dataDir), { readOnly: true })
    try {
      let count = 0
      db.function("visit", { deterministic: false, varargs: true }, () => {
        count++
        return 1
      })
      for (const table of ["slots", "versions", "state_events", "forks", "fork_overrides"])
        db.exec(`CREATE TEMP VIEW ${table} AS SELECT * FROM main.${table} WHERE visit(rowid)`)
      const counted = text.replaceAll(/\bslots (\w+) INDEXED BY/g, "main.slots $1 INDEXED BY")
      const rows = db.prepare(counted).all(...(params as Array<string | number | null>))
      return { rows: rows.length, visited: count }
    } finally {
      db.close()
    }
  })

/** StateEventsAt's query before chains: a walk up parent links to the root. */
const eventsBefore = (sql: SqlClient.SqlClient, chatId: ChatId, slotId: SlotId) => sql`
  WITH RECURSIVE path(id) AS (
    SELECT id FROM slots WHERE id = ${slotId} AND chat_id = ${chatId}
    UNION ALL
    SELECT s.parent_slot_id FROM slots s JOIN path p ON s.id = p.id WHERE s.parent_slot_id IS NOT NULL
  )
  SELECT e.key, e.scope, e.value_json
  FROM state_events e LEFT JOIN path p ON p.id = e.slot_id LEFT JOIN slots s ON s.id = p.id
  WHERE e.chat_id = ${chatId} AND e.superseded_by_changeset IS NULL
    AND (e.slot_id IS NULL OR (p.id IS NOT NULL AND s.deleted_at IS NULL))
    AND (e.version_id IS NULL OR e.version_id = s.selected_version_id)
  ORDER BY coalesce(s.depth, -1), e.seq`

describe("paths by chain segment", () => {
  it.live(
    "paging back through a 100,000-slot path with 200 branch points reconstructs it without gaps",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(100_000)
        yield* Effect.gen(function* () {
          const reader = yield* Database.Reader
          const page = (leafSlotId: SlotId | null, limit: number) =>
            reader.GetPath({ userId: f.userId, chatId: f.chatId, leafSlotId, limit })
          const read = (from: SlotId | null, limit: number) =>
            Effect.gen(function* () {
              const ids: Array<string> = []
              let next: SlotId | null = from
              let first = true
              while (first || next !== null) {
                first = false
                const window: Effect.Success<ReturnType<typeof page>> = yield* page(next, limit)
                ids.unshift(...window.entries.map((e) => e.slotId))
                next = window.olderLeafSlotId
              }
              return ids
            })
          const expected = (to: number) => Array.from({ length: to + 1 }, (_, i) => `p-${i}`)
          assert.deepStrictEqual(yield* read(null, 1000), expected(f.length))
          // Small windows through the branch points, so they start and end at every offset
          // from a segment's boundaries.
          assert.deepStrictEqual(yield* read("p-1100" as SlotId, 7), expected(1100))

          const events = yield* reader.StateEventsAt({ userId: f.userId, chatId: f.chatId, slotId: null })
          assert.strictEqual(events.length, f.chatWide)

          // The deepest fork shows its own choices at the tip; the chat's first shows the slots' own.
          const shownAtTip = (forkId: string) =>
            Effect.map(
              reader.GetPath({
                userId: f.userId,
                chatId: f.chatId,
                forkId: forkId as ForkId,
                leafSlotId: `p-${f.length}` as SlotId,
                limit: 20
              }),
              (path) => ({
                alternates: path.entries.filter((e) => e.version.id.startsWith("w-")).length,
                copies: path.entries.filter((e) => e.version.id.startsWith("x-")).length
              })
            )
          // The deepest fork inherited the copies, but shows the alternates in their place.
          assert.deepStrictEqual(yield* shownAtTip(DEEP_FORK), { alternates: ALTERNATES, copies: 0 })
          assert.deepStrictEqual(yield* shownAtTip(f.chatId), { alternates: 0, copies: ALTERNATES })
          assert.deepStrictEqual(yield* shownAtTip(`f-${LINEAGE_DEPTH + 1}`), { alternates: 0, copies: ALTERNATES })
        }).pipe(Effect.provide(layer(f.dataDir)))

        // StateEventsAt at the tip, against the walk it replaced.
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const tip = `p-${f.length}` as SlotId
          const now = yield* stateEventsOnPath(sql, f.chatId, tip)
          assert.deepStrictEqual(now, yield* eventsBefore(sql, f.chatId, tip))
          assert.strictEqual(now.length, f.chatWide + 51 + 1)
        }).pipe(Effect.provide(SqliteClient.layer({ filename: databaseFile(f.dataDir), readonly: true })))
      }),
    300_000
  )

  it.live(
    "rows visited by a window and by StateEventsAt stay flat from 2,000 to 100,000 slots",
    () =>
      Effect.gen(function* () {
        const measure = (f: Fixture) =>
          Effect.gen(function* () {
            const tip = `p-${f.length}` as SlotId
            return {
              tipWindow: yield* visits(f, (sql) => pathWindow(sql, f.chatId, tip, 200)),
              forkTipWindow: yield* visits(f, (sql) => pathWindow(sql, f.chatId, tip, 200, DEEP_FORK)),
              forkBranchyWindow: yield* visits(f, (sql) =>
                pathWindow(sql, f.chatId, "p-1100" as SlotId, 200, DEEP_FORK)
              ),
              branchyWindow: yield* visits(f, (sql) => pathWindow(sql, f.chatId, "p-1100" as SlotId, 200)),
              events: yield* visits(f, (sql) => stateEventsOnPath(sql, f.chatId, tip)),
              eventsBefore: yield* visits(f, (sql) => eventsBefore(sql, f.chatId, tip))
            }
          })
        const smallFixture = yield* fixture(2_000)
        const small = yield* measure(smallFixture)
        const large = yield* measure(yield* fixture(100_000))
        console.log(`Rows visited, 2,000 / 100,000 slots: ${JSON.stringify(small)} / ${JSON.stringify(large)}`)

        // The probe sees the real traversal: the old walk to the root grows with the length.
        assert.isAbove(large.eventsBefore.visited, 40 * small.eventsBefore.visited)
        assert.deepStrictEqual(large.tipWindow, small.tipWindow)
        assert.deepStrictEqual(large.branchyWindow, small.branchyWindow)
        assert.deepStrictEqual(large.forkTipWindow, small.forkTipWindow)
        assert.deepStrictEqual(large.forkBranchyWindow, small.forkBranchyWindow)
        assert.strictEqual(small.forkTipWindow.rows, 200)
        // Per slot: the fork's row and at most one override lookup per lineage entry for each
        // of the selection, the copy shown for it and its two flags, never the chat's 30,000
        // overrides.
        assert.isBelow(small.forkTipWindow.visited, small.tipWindow.visited + 200 * (1 + 4 * LINEAGE_DEPTH))
        assert.deepStrictEqual(large.events, small.events)
        assert.strictEqual(small.tipWindow.rows, 200)
        assert.strictEqual(small.branchyWindow.rows, 200)
        assert.strictEqual(small.events.rows, smallFixture.chatWide + 51 + 1)
      }),
    300_000
  )

  it.live("StateEventsAt reaches its events and slots by index", () =>
    Effect.gen(function* () {
      const f = yield* fixture(2_000)
      const [text, params] = yield* compiled(f, (sql) =>
        stateEventsOnPath(sql, f.chatId, `p-${f.length}` as SlotId, DEEP_FORK)
      )
      const db = new DatabaseSync(databaseFile(f.dataDir), { readOnly: true })
      const plan = (
        db.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...(params as Array<string | number | null>)) as Array<{
          detail: string
        }>
      ).map((row) => row.detail)
      db.close()
      // Only the segments, the events found and a fork's lineage (for an event attached to
      // a version: its selection there, and the copy standing in for it) are scanned, never a
      // table; the lineage's overrides are found by index.
      assert.deepStrictEqual(
        plan.filter((step) => step.startsWith("SCAN")),
        ["SCAN g", "SCAN g", "SCAN ev", "SCAN el VIRTUAL TABLE INDEX 1:", "SCAN el VIRTUAL TABLE INDEX 1:"],
        plan.join("\n")
      )
      assert.includeMembers(
        plan,
        [
          "SEARCH e USING INDEX state_events_chain (chat_id=? AND slot_chain_id=? AND slot_depth>? AND slot_depth<?)",
          "SEARCH e USING INDEX state_events_position (chat_id=? AND slot_id=?)",
          "SEARCH s USING INDEX sqlite_autoindex_slots_1 (id=?) LEFT-JOIN",
          "SEARCH eo USING INDEX fork_overrides_point (fork_id=? AND kind=? AND target_id=? AND seq<?)"
        ],
        plan.join("\n")
      )
    })
  )
})
