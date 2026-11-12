// SearchMessages at the owner's scale (ARCHITECTURE §12 "Finding a message"): a 3,000-message
// chat with 300 branches, 20 swipes on every message (63,000 versions with the common word),
// each branch selecting a swipe on twenty early messages. A word in every 50th message and in
// all of its swipes finds each message once, with the branches that show it; a word every
// version has fills the first page from the newest messages, skipping their swipes. Budget
// (stated in ARCHITECTURE §12): every page under 1 s, the median of repeated reads, here on a
// shared host; the first page of a rare word, and of a common one, well under that.
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@rp/shared/domain.ts"
import type { MessageSearchPage } from "@rp/shared/messageSearch.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

const LENGTH = 3000
const FORKS = 300
const SWIPES = 40
const BUDGET_MS = 1000

describe("message search at scale", () => {
  const config = testConfig()
  it.effect(
    "pages through 459,000 versions in nine chats and 300 branches within the budget",
    () =>
      Effect.gen(function* () {
        const api = yield* client()
        const userId = (yield* api.Whoami()).id
        const writer = yield* Writer
        const reader = yield* Reader
        const chat = yield* writer.CreateChat({
          userId,
          kind: "rp",
          status: "active",
          title: "Scale",
          participants: [],
          greeting: null
        })
        const c = chat.id
        const main = chat.currentForkId!
        const n = `WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<${LENGTH - 1})`
        const k = `WITH RECURSIVE k(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM k WHERE x<${FORKS - 1})`
        yield* fixtureSql(config.dataDir, [
          // Each message with its swipes right after it, as replies and swipes are written.
          {
            sql: `${n}, w(y) AS (SELECT 0 UNION ALL SELECT y+1 FROM w WHERE y<${SWIPES})
              INSERT INTO version_records(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,created_at,updated_at)
              SELECT CASE WHEN y=0 THEN ?||'-v'||x ELSE ?||'-w'||x||'-'||y END,?||'-s'||x,y,'complete',NULL,
                CASE WHEN y=0 THEN 'human' ELSE 'model' END,
                CASE WHEN y=0 AND x%50=0 THEN 'The lighthouse burns at '||x||' while the tide turns.'
                  WHEN y=0 THEN 'The tide turns at '||x||'.'
                  ELSE 'A swipe of the tide and the lighthouse at '||x||'/'||y||'.' END,
                'verbatim',CASE WHEN y=0 THEN 'user_written' ELSE 'generated' END,1,1
              FROM n CROSS JOIN w ORDER BY x, y`,
            params: [c, c, c]
          },
          {
            sql: `${n} INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at,fork_id)
              SELECT ?||'-s'||x,?,CASE WHEN x=0 THEN NULL ELSE ?||'-s'||(x-1) END,x,?||'-v'||x,1,? FROM n`,
            params: [c, c, c, c, main]
          },
          // A side reply at each branch's base, off the main path.
          {
            sql: `${k} INSERT INTO version_records(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,created_at,updated_at)
              SELECT ?||'-sv'||x,?||'-side'||x,0,'complete',NULL,'human','A side reply.','verbatim','user_written',1,1 FROM k`,
            params: [c, c]
          },
          {
            sql: `${k} INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at,fork_id)
              SELECT ?||'-side'||x,?,?||'-s'||(10*(x+1)-1),10*(x+1),?||'-sv'||x,1,? FROM k`,
            params: [c, c, c, c, main]
          },
          { sql: "UPDATE forks SET tip_slot_id=? WHERE id=?", params: [`${c}-s${LENGTH - 1}`, main] },
          {
            sql: `${k} INSERT INTO forks(id,chat_id,parent_fork_id,branched_at,base_slot_id,tip_slot_id,created_at)
              SELECT ?||'-f'||x,?,?,0,?||'-s'||(10*(x+1)-1),?||'-side'||x,1+x FROM k`,
            params: [c, c, main, c, c]
          },
          // Every branch shows the first swipe on messages 0, 10, … 190.
          {
            sql: `${k}, j(y) AS (SELECT 0 UNION ALL SELECT y+1 FROM j WHERE y<19)
              INSERT INTO fork_overrides(id,chat_id,fork_id,seq,kind,target_id,slot_id,slot_depth,value_id)
              SELECT ?||'-o'||x||'-'||y,?,?||'-f'||x,1,'select',?||'-s'||(10*y),?||'-s'||(10*y),10*y,?||'-w'||(10*y)||'-1'
              FROM k CROSS JOIN j`,
            params: [c, c, c, c, c, c]
          }
        ])
        const page = (text: string, cursor: { before: number } | null) =>
          reader.SearchMessages({ userId: userId as UserId, text, cursor, limit: 20 })

        // Every 50th message once, newest first, with the branches whose path holds it.
        const all: Array<{ slot: string; branches: number; names: number; text: string }> = []
        let cursor: { before: number } | null = null
        const cursors: Array<{ before: number } | null> = [null]
        do {
          const found: MessageSearchPage = yield* page("lighthouse", cursor)
          all.push(
            ...found.hits.map((h) => ({
              slot: h.slotId,
              branches: h.branchCount,
              names: h.branches.length,
              text: h.excerpt.text
            }))
          )
          cursor = found.next
          if (cursor) cursors.push(cursor)
        } while (cursor !== null)
        const fifty = Array.from({ length: LENGTH / 50 }, (_, i) => `${c}-s${LENGTH - 50 - 50 * i}`)
        // The messages themselves; the swipes the branches show on messages 0, 10, … 190 too.
        assert.deepStrictEqual(
          all.filter((h) => h.text.startsWith("The lighthouse")).map((h) => h.slot),
          fifty
        )
        assert.lengthOf(all, LENGTH / 50 + 20)
        // Message 2950 is on the main line and on branches 295–299.
        assert.strictEqual(all[0]!.branches, 6)
        assert.strictEqual(all[0]!.names, 3)
        // Message 0's own text is only the main line's: every branch shows its swipe.
        assert.strictEqual(all.find((h) => h.text.startsWith("The lighthouse burns at 0 "))!.branches, 1)
        assert.strictEqual(
          all.find((h) => h.text.startsWith("A swipe of the tide and the lighthouse at 0/"))!.branches,
          300
        )

        // Many more chats and newer postings exercise the cursor deep in a shared index.
        for (let i = 0; i < 8; i++) {
          const other = yield* writer.CreateChat({
            userId,
            kind: "rp",
            status: "active",
            title: `Other ${i}`,
            participants: [],
            greeting: null
          })
          const id = other.id
          const numbers = "WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<1999)"
          yield* fixtureSql(config.dataDir, [
            {
              sql: `${numbers}, w(y) AS (SELECT 0 UNION ALL SELECT y+1 FROM w WHERE y<20)
              INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at)
              SELECT ?||'-v'||x||'-'||y,?||'-s'||x,y,'complete','human','The tide and lighthouse '||x,'verbatim','user_written',1,1 FROM n CROSS JOIN w ORDER BY x,y`,
              params: [id, id]
            },
            {
              sql: `${numbers} INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at,fork_id)
              SELECT ?||'-s'||x,?,CASE WHEN x=0 THEN NULL ELSE ?||'-s'||(x-1) END,x,?||'-v'||x||'-0',1,? FROM n`,
              params: [id, id, id, id, other.currentForkId]
            },
            { sql: "UPDATE forks SET tip_slot_id=? WHERE id=?", params: [`${id}-s1999`, other.currentForkId] }
          ])
        }
        const plans = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: "EXPLAIN QUERY PLAN SELECT 1 FROM fork_overrides WHERE target_id=? AND kind='select' AND value_id=?",
              params: [`${c}-s0`, `${c}-w0-1`]
            },
            {
              sql: "EXPLAIN QUERY PLAN SELECT rowid FROM versions_fts WHERE versions_fts MATCH ? AND rowid < ? ORDER BY rowid DESC LIMIT 500",
              params: ['"lighthouse"*', 100]
            }
          ],
          { readOnly: true }
        )
        process.stderr.write(`Search query plans: ${JSON.stringify(plans)}\n`)
        assert.include(JSON.stringify(plans[0]), "COVERING INDEX fork_overrides_target")
        assert.include(JSON.stringify(plans[1]), "M1<")

        const median = (run: Effect.Effect<unknown, unknown>) =>
          Effect.gen(function* () {
            const times: Array<number> = []
            for (let i = 0; i < 7; i++) {
              const start = performance.now()
              yield* run
              times.push(performance.now() - start)
            }
            return times.sort((a, b) => a - b)[3]!
          })
        const pages = []
        for (const at of cursors) pages.push(yield* median(page("lighthouse", at)))
        const common = yield* median(page("tide", null))
        process.stderr.write(
          `SearchMessages at ${LENGTH} messages × ${SWIPES + 1} versions, ${FORKS} branches: rare pages ${pages
            .map((t) => t.toFixed(0))
            .join(", ")} ms, common first page ${common.toFixed(0)} ms\n`
        )
        for (const t of pages) assert.isBelow(t, BUDGET_MS)
        assert.isBelow(common, BUDGET_MS)
      }).pipe(Effect.provide(serverLayer(config))),
    600_000
  )
})
