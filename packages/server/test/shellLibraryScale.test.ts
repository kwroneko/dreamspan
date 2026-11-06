// GetShellLibrary on a large library (ARCHITECTURE.md §12): 420 cards, 2,100 chats and
// about 500,000 messages, ten chats of 5,000 and every fifth chat a group of three. Opt-in
// (`SHELL_SCALE=1`): writing the library takes a minute or more on the shared host. Prints
// the cold read (every fork summarized), the warm read (every summary kept) and a read with
// one 5,000-message chat changed, each the median of several, and the plans of the
// summarizing statements.
import { writeFileSync } from "node:fs"
import { assert, it as plain, layer } from "@effect/vitest"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { shellEventsQuery, shellSlotsQuery } from "../src/db/shellQueries.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

const CARDS = 420
const CHATS = 2100
const BIG = 10
const BIG_MESSAGES = 5000
const MESSAGES = 215

const config = testConfig({ dbReaders: 2 })

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

const build = (userId: string, now: number) => {
  const series = (name: string, n: number) =>
    `${name}(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM ${name} WHERE i < ${n - 1})`
  return fixtureSql(config.dataDir, [
    {
      sql: `CREATE TEMP TABLE sizes AS WITH RECURSIVE ${series("n", CHATS)}
        SELECT i, CASE WHEN i < ${BIG} THEN ${BIG_MESSAGES} ELSE ${MESSAGES} END AS n FROM n`
    },
    {
      sql: `INSERT INTO entities (id, owner_user_id, kind, created_at) WITH RECURSIVE ${series("n", CARDS)}
        SELECT printf('e-%04d', i), ?, 'card', ? + i FROM n`,
      params: [userId, now - 1_000_000]
    },
    {
      sql: `INSERT INTO entity_revisions (id, entity_id, doc_json, doc_hash, schema_version, origin, created_at)
        WITH RECURSIVE ${series("n", CARDS)} SELECT printf('v-%04d', i), printf('e-%04d', i),
          json_object('name', 'Card ' || i, 'description', 'A synthetic card.', 'first_mes', 'Hello.'),
          'h' || i, 1, 'import', ? FROM n`,
      params: [now]
    },
    {
      sql: `INSERT INTO entity_refs (id, entity_id, ref_kind, head_revision_id, label, created_at, updated_at)
        WITH RECURSIVE ${series("n", CARDS)} SELECT printf('r-%04d', i), printf('e-%04d', i), 'upstream',
          printf('v-%04d', i), 'Card ' || i, ?, ? FROM n`,
      params: [now, now]
    },
    {
      sql: `INSERT INTO chats (id, owner_user_id, kind, status, title, created_at, last_message_at)
        SELECT printf('c-%05d', i), ?, 'rp', 'active', 'Chat ' || i, ?, ? + i FROM sizes`,
      params: [userId, now, now]
    },
    // Every fifth chat is a group of three; 20 cards are never used.
    {
      sql: `INSERT INTO state_events (id, chat_id, seq, key, value_json, origin, created_at, fork_id, fork_seq)
        SELECT printf('j-%05d-%d', i, k), printf('c-%05d', i), k + 1, 'participant.join',
          json_object('entity', printf('e-%04d', CASE k WHEN 0 THEN i % 400 WHEN 1 THEN (i * 3 + 1) % 400 ELSE (i * 7 + 2) % 400 END)),
          'import', ?, printf('c-%05d', i), k + 1
        FROM sizes JOIN (SELECT 0 AS k UNION ALL SELECT 1 UNION ALL SELECT 2) WHERE k = 0 OR i % 5 = 0`,
      params: [now]
    },
    {
      sql: `INSERT INTO versions (id, slot_id, ordinal, status, speaker_entity_id, writer, content, macro_mode, origin, created_at, updated_at)
        WITH RECURSIVE ${series("d", BIG_MESSAGES)}
        SELECT 'v-' || s.i || '-' || d.i, 's-' || s.i || '-' || d.i, 0, 'complete',
          CASE WHEN d.i % 2 = 1 THEN printf('e-%04d', CASE WHEN s.i % 5 = 0 AND d.i % 4 = 3 THEN (s.i * 3 + 1) % 400 ELSE s.i % 400 END) END,
          CASE WHEN d.i % 2 = 1 THEN 'model' ELSE 'human' END,
          printf('%.200c', 'x') || ' ' || d.i, 'verbatim', 'imported', ? + d.i * 1000, ? + d.i * 1000
        FROM sizes s JOIN d ON d.i < s.n`,
      params: [now - 10_000_000, now - 10_000_000]
    },
    {
      sql: `INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, created_at)
        WITH RECURSIVE ${series("d", BIG_MESSAGES)}
        SELECT 's-' || s.i || '-' || d.i, printf('c-%05d', s.i),
          CASE WHEN d.i = 0 THEN NULL ELSE 's-' || s.i || '-' || (d.i - 1) END, d.i, 'v-' || s.i || '-' || d.i, ?
        FROM d JOIN sizes s ON d.i < s.n ORDER BY d.i, s.i`,
      params: [now - 10_000_000]
    },
    {
      sql: `UPDATE chats SET active_leaf_slot_id = (SELECT 's-' || i || '-' || (n - 1) FROM sizes WHERE printf('c-%05d', i) = chats.id)`
    }
  ])
}

const measure = () =>
  Effect.gen(function* () {
    const api = yield* client()
    const me = yield* api.Whoami()
    const now = Date.now()
    const started = performance.now()
    yield* build(me.id, now)
    const buildSeconds = (performance.now() - started) / 1000
    const reader = yield* Reader
    const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const t = performance.now()
        const value = yield* effect
        return { value, ms: performance.now() - t }
      })
    const cold = yield* timed(api.GetShellLibrary())
    assert.lengthOf(cold.value.forks, CHATS)
    // The answer's summaries are stored after it, in the background.
    const settled = Effect.gen(function* () {
      for (let n = 0; n < 600; n++) {
        if ((yield* reader.ShellLibrary({ userId: me.id })).fresh.length === 0) return
        yield* Effect.sleep("100 millis")
      }
      assert.fail("the summaries were never stored")
    })
    yield* settled
    const warm: Array<number> = []
    for (let n = 0; n < 9; n++) warm.push((yield* timed(api.GetShellLibrary())).ms)
    const dirty: Array<number> = []
    for (let n = 0; n < 5; n++) {
      // A message appended to the first 5,000-message chat.
      const depth = BIG_MESSAGES + n
      yield* fixtureSql(config.dataDir, [
        {
          sql: `INSERT INTO versions (id, slot_id, ordinal, status, speaker_entity_id, writer, content, macro_mode, origin, created_at, updated_at)
            VALUES (?, ?, 0, 'complete', 'e-0000', 'model', 'Appended.', 'verbatim', 'generated', ?, ?)`,
          params: [`v-0-${depth}`, `s-0-${depth}`, now + n, now + n]
        },
        {
          sql: `INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, created_at)
            VALUES (?, 'c-00000', ?, ?, ?, ?)`,
          params: [`s-0-${depth}`, `s-0-${depth - 1}`, depth, `v-0-${depth}`, now + n]
        },
        { sql: `UPDATE chats SET active_leaf_slot_id = ? WHERE id = 'c-00000'`, params: [`s-0-${depth}`] }
      ])
      const read = yield* timed(api.GetShellLibrary())
      dirty.push(read.ms)
      const fork = read.value.forks.find((f) => f.chat.id === "c-00000")!
      assert.strictEqual(fork.messages, depth + 1)
      assert.strictEqual(fork.preview, "Appended.")
      yield* settled
    }
    const plans = yield* fixtureSql(
      config.dataDir,
      [shellSlotsQuery, shellEventsQuery].map((query) => ({
        sql: `EXPLAIN QUERY PLAN ${query}`,
        params: [JSON.stringify(["c-00000"])]
      })),
      { readOnly: true }
    )
    const library = yield* reader.ShellLibrary({ userId: me.id })
    const measured = JSON.stringify({
      cards: CARDS,
      chats: CHATS,
      messages: BIG * BIG_MESSAGES + (CHATS - BIG) * MESSAGES,
      buildSeconds: +buildSeconds.toFixed(1),
      coldMs: Math.round(cold.ms),
      warmMedianMs: Math.round(median(warm)),
      warmMs: warm.map(Math.round),
      dirtyBigChatMedianMs: Math.round(median(dirty)),
      dirtyMs: dirty.map(Math.round),
      usedCards: library.cards.filter((c) => c.card.chats > 0).length
    })
    const planText = plans.map((plan) => plan.map((row) => `${row.id}/${row.parent} ${row.detail}`).join("\n"))
    process.stdout.write(`${measured}\n${planText.join("\n\n")}\n`)
    if (process.env.SHELL_SCALE_OUT)
      writeFileSync(process.env.SHELL_SCALE_OUT, `${measured}\n${planText.join("\n\n")}\n`)
    assert.strictEqual(library.cards.filter((c) => c.card.chats > 0).length, 400)
    assert.isBelow(median(warm), 100)
  })

if (process.env.SHELL_SCALE === "1") {
  layer(serverLayer(config), { excludeTestServices: true, timeout: "30 minutes" })("shell library at scale", (it) => {
    it.effect("420 cards, 2,100 chats, 500,000 messages", measure, 30 * 60_000)
  })
} else {
  plain.skip("GetShellLibrary on 500,000 messages (set SHELL_SCALE=1)", () => {})
}
