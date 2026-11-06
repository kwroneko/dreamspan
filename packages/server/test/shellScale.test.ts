import { shellSlotsQuery, shellEventsQuery } from "../src/db/shellQueries.ts"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
describe("group read scale", () => {
  it.live(
    "groups 5,000 active ten-message paths within the read budget",
    () => {
      const config = testConfig({ dbWorkers: "bundle" })
      return Effect.gen(function* () {
        const api = yield* client()
        const me = yield* api.Whoami()
        const now = Date.now()
        // Written straight into the file: 5,000 chats through the RPCs would take minutes.
        const series = (n: number) =>
          `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${n - 1})`
        const doc = `json_object('name', 'Card ' || i, 'description', printf('%.4000c', 'x'), 'first_mes', 'Hello.')`
        yield* fixtureSql(config.dataDir, [
          {
            sql: `INSERT INTO entities (id, owner_user_id, kind, created_at) ${series(1000)}
            SELECT printf('e-%04d', i), ?, 'card', ? FROM n`,
            params: [me.id, now]
          },
          {
            sql: `INSERT INTO entity_revisions (id, entity_id, doc_json, doc_hash, schema_version, origin, created_at)
            ${series(1000)} SELECT printf('v-%04d', i), printf('e-%04d', i), ${doc}, 'h' || i, 1, 'import', ? FROM n`,
            params: [now]
          },
          {
            sql: `INSERT INTO entity_refs (id, entity_id, head_revision_id, label, created_at, updated_at)
            ${series(1000)} SELECT printf('r-%04d', i), printf('e-%04d', i), printf('v-%04d', i),
              'Card ' || i, ?, ? FROM n`,
            params: [now, now]
          },
          {
            sql: `INSERT INTO chats (id, owner_user_id, kind, status, title, created_at, last_message_at) ${series(5000)}
            SELECT printf('c-%05d', i), ?, 'rp', 'active', 'Chat ' || i, ?, ? + i FROM n`,
            params: [me.id, now, now]
          },
          // Two cards a chat, every third chat a group of three, and other settings around them.
          {
            sql: `INSERT INTO state_events (id, chat_id, seq, key, value_json, origin, created_at) ${series(5000)}
            SELECT printf('s-%05d-%d', i, k.k), printf('c-%05d', i), k.k,
              CASE WHEN k.k < 3 THEN 'participant.join' ELSE 'model.binding' END,
              CASE WHEN k.k < 3 THEN json_object('entity', printf('e-%04d', (i * (k.k + 1) * 7) % 800))
                ELSE json_object('connection', 'x', 'model', 'y') END,
              'import', ?
            FROM n JOIN (SELECT 0 AS k UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4) k
            WHERE k.k <> 2 OR i % 3 = 0`,
            params: [now]
          },
          {
            sql: `INSERT INTO lanes (id, chat_id, name, created_at) ${series(5000)}
            SELECT 'l-' || i, printf('c-%05d', i), 'main', ? FROM n`,
            params: [now]
          },
          {
            sql: `INSERT INTO versions (id, slot_id, ordinal, status, writer, macro_mode, origin, cast_json, created_at, updated_at)
            ${series(5000)}, depths(d) AS (SELECT 0 UNION ALL SELECT d + 1 FROM depths WHERE d < 9)
            SELECT 'v-slot-' || i || '-' || d, 'slot-' || i || '-' || d, 0, 'complete', 'human', 'verbatim', 'imported',
              (SELECT json_group_array(DISTINCT json_extract(e.value_json, '$.entity')) FROM state_events e
                WHERE e.chat_id = printf('c-%05d', i) AND e.key = 'participant.join'), ?, ? FROM n, depths`,
            params: [now, now]
          },
          {
            sql: `INSERT INTO slots (id, chat_id, lane_id, parent_slot_id, depth, selected_version_id, created_at)
            ${series(5000)}, depths(d) AS (SELECT 0 UNION ALL SELECT d + 1 FROM depths WHERE d < 9)
            SELECT 'slot-' || i || '-' || d, printf('c-%05d', i), 'l-' || i,
              CASE WHEN d = 0 THEN NULL ELSE 'slot-' || i || '-' || (d - 1) END, d, 'v-slot-' || i || '-' || d, ? FROM n, depths ORDER BY d, i`,
            params: [now]
          },
          { sql: "UPDATE chats SET active_leaf_slot_id = 'slot-' || CAST(substr(id, 3) AS INTEGER) || '-9'" },
          {
            sql: `INSERT INTO state_events (id, chat_id, slot_id, seq, key, value_json, origin, created_at)
            ${series(5000)} SELECT 'played-' || i || '-' || k, printf('c-%05d', i), 'slot-' || i || '-9', k,
              'played_by_me.set', CASE WHEN k = 0 THEN json_object('entities', json_array(printf('e-%04d', i * 7 % 800))) ELSE json_object('entities', json_array()) END, 'import', ? FROM n JOIN (SELECT 0 AS k UNION ALL SELECT 1)`,
            params: [now]
          }
        ])
        // The groups (two or three characters a chat, each chat titled apart): one read too.
        const plans = yield* fixtureSql(
          config.dataDir,
          [shellSlotsQuery, shellEventsQuery].map((query) => ({
            sql: `EXPLAIN QUERY PLAN ${query}`,
            params: [JSON.stringify(["c-00000", "c-00001"])]
          })),
          { readOnly: true }
        )
        for (const plan of plans) {
          const details = plan.map((row) => String(row.detail))
          assert.isTrue(details.some((detail) => /SEARCH c USING .*\(id=\?\)/.test(detail)))
          assert.isFalse(details.some((detail) => /^SCAN [se] /.test(detail)))
        }
        // The first read walks every chat and stores the summaries after answering
        // (db/forkSummaries.ts); the timed read is the steady state, once they're stored.
        yield* api.GetShellLibrary()
        for (let stored = 0; stored < 5000;) {
          yield* Effect.sleep("200 millis")
          const [row] = yield* fixtureSql(
            config.dataDir,
            [{ sql: "SELECT count(*) AS n FROM fork_summaries", params: [] }],
            {
              readOnly: true
            }
          )
          stored = Number(row![0]!.n)
        }
        const groupsStarted = performance.now()
        const groups = yield* api.GetShellLibrary()
        const groupsTook = performance.now() - groupsStarted
        assert.lengthOf(groups.forks, 5000)
        const bytes = JSON.stringify(groups).length
        console.log(
          `GetShellLibrary: 1,000 cards / 5,000 chats / 50,000 slots: ${groupsTook.toFixed(0)} ms; wire JSON ${bytes} bytes`
        )
        assert.isBelow(groupsTook, 2000)
        // Cards are described once in people, not repeated in every fork (3.8 MB when they were).
        // The whole read is for tools and tests now; with fheader's branch fields it's ~2.35 MB here.
        assert.isBelow(bytes, 3_000_000)
        // What the app sends a page load (fux1): the cards, and the first 100 rows of the chat list.
        const cards = yield* api.GetShellCards()
        const page = yield* api.GetShellForks({
          entity: null,
          chat: null,
          search: "",
          sort: "recent",
          sections: [{ id: "chats", limit: 100 }]
        })
        assert.strictEqual(page.sections[0]!.total, 5000)
        assert.lengthOf(page.sections[0]!.rows, 100)
        const pageBytes = JSON.stringify(cards).length + JSON.stringify(page).length
        console.log(`GetShellCards + first 100 chats: wire JSON ${pageBytes} bytes`)
        assert.isBelow(pageBytes, 600_000)
        const people = new Set(groups.people.map((c) => c.entityId))
        assert.isTrue(groups.forks.every((f) => f.cast.every((id) => people.has(id))))
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
    },
    120_000
  )
})
