// The agent's search_chat at the owner's scale (spec/AGENTIC.md U4): full-text search over a
// 5,000-message path in a chat with 300 forks, each with its own selections, a side branch at
// each fork's base and a swipe on every tenth message. Searching in one fork finds only what that
// fork shows on the path to the reply's parent: never a side branch, another fork's selection or
// an unselected swipe. Timed as the median of repeated reads, so one slow moment on a shared host
// doesn't decide it.
import { assert, describe, it } from "@effect/vitest"
import type { ForkId, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

const LENGTH = 5000
const FORKS = 300

describe("search_chat at scale", () => {
  const config = testConfig()
  it.effect(
    "searches a 5,000-message path among 300 forks in under 50 ms",
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
        const target = `${c}-target`
        const n = `WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<${LENGTH - 1})`
        const k = `WITH RECURSIVE k(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM k WHERE x<${FORKS - 1})`
        yield* fixtureSql(config.dataDir, [
          // The path: every 50th message names the lighthouse; every 10th has a swipe that does.
          {
            sql: `${n} INSERT INTO versions(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,created_at,updated_at)
              SELECT ?||'-v'||x,?||'-s'||x,0,'complete',NULL,'human',
                CASE WHEN x%50=0 THEN 'The lighthouse burns at '||x||'.' ELSE 'The tide turns at '||x||'.' END,
                'verbatim','user_written',1,1 FROM n`,
            params: [c, c]
          },
          {
            sql: `${n} INSERT INTO versions(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,created_at,updated_at)
              SELECT ?||'-w'||x,?||'-s'||x,1,'complete',NULL,'model','A lighthouse swipe at '||x||'.','verbatim','generated',1,1
              FROM n WHERE x%10=0`,
            params: [c, c]
          },
          {
            sql: `${n} INSERT INTO slots(id,chat_id,lane_id,parent_slot_id,depth,selected_version_id,created_at,fork_id)
              SELECT ?||'-s'||x,?,(SELECT id FROM lanes WHERE chat_id=? LIMIT 1),
                CASE WHEN x=0 THEN NULL ELSE ?||'-s'||(x-1) END,x,?||'-v'||x,1,? FROM n`,
            params: [c, c, c, c, c, main]
          },
          // A side reply at each fork's base, off the main path, naming the lighthouse too.
          {
            sql: `${k} INSERT INTO versions(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,created_at,updated_at)
              SELECT ?||'-sv'||x,?||'-side'||x,0,'complete',NULL,'human','A lighthouse off the path.','verbatim','user_written',1,1 FROM k`,
            params: [c, c]
          },
          {
            sql: `${k} INSERT INTO slots(id,chat_id,lane_id,parent_slot_id,depth,selected_version_id,created_at,fork_id)
              SELECT ?||'-side'||x,?,(SELECT id FROM lanes WHERE chat_id=? LIMIT 1),?||'-s'||(15*(x+1)-1),15*(x+1),?||'-sv'||x,1,? FROM k`,
            params: [c, c, c, c, c, main]
          },
          { sql: "UPDATE forks SET tip_slot_id=? WHERE id=?", params: [`${c}-s${LENGTH - 1}`, main] },
          // 300 forks, each off its side reply, selecting swipes near its base.
          {
            sql: `${k} INSERT INTO forks(id,chat_id,parent_fork_id,branched_at,base_slot_id,tip_slot_id,created_at)
              SELECT ?||'-f'||x,?,?,0,?||'-s'||(15*(x+1)-1),?||'-side'||x,1
              FROM k`,
            params: [c, c, main, c, c]
          },
          {
            sql: `${k}, j(y) AS (SELECT 0 UNION ALL SELECT y+1 FROM j WHERE y<19)
              INSERT INTO fork_overrides(id,chat_id,fork_id,seq,kind,target_id,slot_id,slot_depth,value_id)
              SELECT ?||'-o'||x||'-'||y,?,?||'-f'||x,1,'select',?||'-s'||(10*y),?||'-s'||(10*y),10*y,?||'-w'||(10*y)
              FROM k CROSS JOIN j`,
            params: [c, c, c, c, c, c]
          },
          // The fork searched in: the main path, showing the swipe at every 100th message.
          {
            sql: `INSERT INTO forks(id,chat_id,parent_fork_id,branched_at,base_slot_id,tip_slot_id,created_at)
              VALUES (?,?,?,0,?,?,1)`,
            params: [target, c, main, `${c}-s${LENGTH - 1}`, `${c}-s${LENGTH - 1}`]
          },
          {
            sql: `${n} INSERT INTO fork_overrides(id,chat_id,fork_id,seq,kind,target_id,slot_id,slot_depth,value_id)
              SELECT ?||'-t'||x,?,?,1,'select',?||'-s'||x,?||'-s'||x,x,?||'-w'||x FROM n WHERE x%100=0`,
            params: [c, c, target, c, c, c]
          }
        ])
        const search = (tokens: ReadonlyArray<string>, before: number | null = null) =>
          reader.SearchChat({
            userId,
            chatId: c,
            forkId: target as ForkId,
            leafSlotId: `${c}-s${LENGTH - 1}` as SlotId,
            tokens,
            before,
            limit: 200
          })
        const hits = (yield* search(["lighthouse"]))!
        // Every 50th message, as the fork shows it; nothing off the path or unselected.
        assert.strictEqual(hits.length, LENGTH / 50)
        assert.deepStrictEqual(
          hits.slice(0, 3).map((h) => [h.position, h.content]),
          [
            [4950, "The lighthouse burns at 4950."],
            [4900, "A lighthouse swipe at 4900."],
            [4850, "The lighthouse burns at 4850."]
          ]
        )
        assert.isFalse(hits.some((h) => h.content.includes("off the path")))
        assert.deepStrictEqual(
          (yield* search(["lighthouse"], 120))!.map((h) => h.position),
          [100, 50, 0]
        )

        const median = (run: Effect.Effect<unknown, unknown>) =>
          Effect.gen(function* () {
            const times: Array<number> = []
            for (let i = 0; i < 15; i++) {
              const start = performance.now()
              yield* run
              times.push(performance.now() - start)
            }
            return times.sort((a, b) => a - b)[7]!
          })
        const rare = yield* median(search(["lighthouse"]))
        // A word most messages have: the newest 200 of thousands of candidates.
        const common = yield* median(search(["tide"]))
        console.log(
          `search_chat at ${LENGTH} messages, ${FORKS} forks: rare ${rare.toFixed(1)} ms, common ${common.toFixed(1)} ms`
        )
        assert.isBelow(rare, 50)
        assert.isBelow(common, 50)
      }).pipe(Effect.provide(serverLayer(config))),
    300_000
  )
})
