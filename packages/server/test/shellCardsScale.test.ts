// The left panel's card reads on 6,000 synthetic cards with fork families of 2–50,
// about 3.2 MB of card documents, some with large embedded lorebooks), or larger with
// `SHELL_CARDS_BOOK_ENTRIES`: GetShellCards, ListCards, ListCardUsage and ListChatGroups, each
// read after a write so no reader's memo answers it, the median of several. Opt-in
// (`SHELL_CARDS_SCALE=1`); prints the timings (and writes them to `SHELL_CARDS_SCALE_OUT`).
import { writeFileSync } from "node:fs"
import { assert, it as plain, layer } from "@effect/vitest"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

const CARDS = Number(process.env.SHELL_CARDS_COUNT ?? 6000)
/** One card in eleven carries a lorebook of this many entries of about 560 characters. */
const BOOK_ENTRIES = Number(process.env.SHELL_CARDS_BOOK_ENTRIES ?? 100)
const READS = 15

// Recorded fork lineage only: families of 2–50, alternating trees and deep chains.
const lineage: Array<{ id: string; parent: string | null }> = []
for (let start = 0, family = 0; start < CARDS; family++) {
  const size = Math.min(2 + (family % 49), CARDS - start)
  for (let member = 0; member < size; member++) {
    const id = (i: number) => `e-${String(i).padStart(4, "0")}`
    lineage.push({
      id: id(start + member),
      parent: member === 0 ? null : id(start + (family % 2 === 0 ? member - 1 : 0))
    })
  }
  start += size
}

const config = testConfig({ dbReaders: 2 })

const median = (values: ReadonlyArray<number>) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

const build = (userId: string, now: number) => {
  const series = (name: string, n: number) =>
    `${name}(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM ${name} WHERE i < ${n - 1})`
  return fixtureSql(config.dataDir, [
    {
      sql: `INSERT INTO entities (id, owner_user_id, kind, created_at, forked_from_entity_id)
        SELECT value ->> 'id', ?, 'card', ? + key, value ->> 'parent' FROM json_each(?)`,
      params: [userId, now - 1_000_000, JSON.stringify(lineage)]
    },
    {
      sql: `CREATE TEMP TABLE book AS WITH RECURSIVE ${series("k", BOOK_ENTRIES)}
        SELECT json_group_array(json_object('id', k.i, 'keys', json_array('key ' || k.i), 'content',
          printf('%.540c', 'b') || ' ' || k.i, 'enabled', json('true'), 'insertion_order', k.i)) AS entries FROM k`
    },
    {
      sql: `INSERT INTO entity_revisions (id, entity_id, doc_json, doc_hash, schema_version, origin, created_at)
        WITH RECURSIVE ${series("n", CARDS)} SELECT printf('v-%04d', i), printf('e-%04d', i),
          json_patch(json_object('name', 'Card ' || i, 'nickname', CASE WHEN i % 3 = 0 THEN 'Nick ' || i END,
            'character_version', 'v' || (i % 4), 'avatar_media_id', printf('m-%04d', i),
            'description', printf('%.2000c', 'd'), 'personality', printf('%.300c', 'p'),
            'scenario', printf('%.300c', 's'), 'first_mes', printf('%.600c', 'f'),
            'mes_example', printf('%.800c', 'x'), 'extensions', json_object('talkativeness', 0.5)),
            CASE WHEN i % 11 = 0 THEN json_object('character_book',
              json_object('name', 'Book ' || i, 'entries', json((SELECT entries FROM book)))) ELSE '{}' END),
          'h' || i, 1, 'import', ? FROM n`,
      params: [now]
    },
    {
      sql: `INSERT INTO entity_refs (id, entity_id, head_revision_id, label, created_at, updated_at)
        WITH RECURSIVE ${series("n", CARDS)} SELECT printf('r-%04d', i), printf('e-%04d', i),
          printf('v-%04d', i), 'Card ' || i, ?, ? FROM n`,
      params: [now, now]
    },
    { sql: `SELECT sum(length(doc_json)) AS bytes FROM entity_revisions` }
  ])
}

const measure = () =>
  Effect.gen(function* () {
    const api = yield* client()
    const me = yield* api.Whoami()
    const built = yield* build(me.id, Date.now())
    const bytes = Number(built.at(-1)![0]!.bytes)
    // Any commit by another connection moves `data_version`, so the next read computes again.
    const touch = fixtureSql(config.dataDir, [
      { sql: `UPDATE entities SET created_at = created_at + 1 WHERE id = 'e-0000'` }
    ])
    const timed = <A, E, R>(read: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const ms: Array<number> = []
        for (let n = 0; n < READS; n++) {
          yield* touch
          const t = performance.now()
          yield* read
          ms.push(performance.now() - t)
        }
        return Math.round(median(ms) * 10) / 10
      })
    const coldStart = performance.now()
    const cards = yield* api.GetShellCards()
    const coldMs = performance.now() - coldStart
    assert.lengthOf(cards.cards, CARDS)
    if (process.env.SHELL_CARDS_SCALE_OUT)
      writeFileSync(`${process.env.SHELL_CARDS_SCALE_OUT}.cards.json`, JSON.stringify(cards.cards))
    const measured = JSON.stringify({
      cards: CARDS,
      forked: lineage.filter((c) => c.parent !== null).length,
      families: lineage.filter((c) => c.parent === null).length,
      coldMs: Math.round(coldMs * 10) / 10,
      // Flat and grouped grids share this read; grouping is entirely in the client.
      bookEntries: BOOK_ENTRIES,
      documentMB: +(bytes / 1e6).toFixed(1),
      readsEach: READS,
      medianMs: {
        GetShellCards: yield* timed(api.GetShellCards()),
        "ShellCards (reader)": yield* timed((yield* Reader).ShellCards({ userId: me.id })),
        // The whole read, computed again whatever the memo holds (no chats here: the cards' part).
        "ShellLibrary (reader, recompute)": yield* timed(
          (yield* Reader).ShellLibrary({ userId: me.id, recompute: true })
        ),
        ListCards: yield* timed(api.ListCards()),
        ListCardUsage: yield* timed(api.ListCardUsage()),
        ListChatGroups: yield* timed(api.ListChatGroups())
      }
    })
    process.stdout.write(`${measured}\n`)
    if (process.env.SHELL_CARDS_SCALE_OUT) writeFileSync(process.env.SHELL_CARDS_SCALE_OUT, `${measured}\n`)
  })

if (process.env.SHELL_CARDS_SCALE === "1") {
  layer(serverLayer(config), { excludeTestServices: true, timeout: "10 minutes" })("shell cards at scale", (it) => {
    it.effect("thousands of cards with fork trees, chains and lorebooks", measure, 10 * 60_000)
  })
} else {
  plain.skip("the left panel's card reads on fork families (set SHELL_CARDS_SCALE=1)", () => {})
}
