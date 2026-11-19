// Synthetic cached summaries: 1,000 chats with 100 branches each. Browsing never walks
// their messages, and sends only the requested chats. SQLite runs in the fixture worker.
import { writeFileSync } from "node:fs"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { CHAT_SORTS } from "@dreamspan/shared/chatBrowse.ts"
import { Generator } from "../src/chat/Generator.ts"
import { FORK_SUMMARY_FORMAT } from "../src/db/forkSummaries.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

it.live(
  "browses 1,000 chats with 100 cached branches each before paging",
  () => {
    const config = testConfig({ dbWorkers: "bundle" })
    return Effect.gen(function* () {
      const api = yield* client()
      const me = yield* api.Whoami()
      yield* fixtureSql(config.dataDir, [
        {
          sql: `INSERT INTO chats (id, owner_user_id, kind, status, title, created_at)
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<999)
        SELECT printf('scale-%04d', i), ?, 'rp', 'active', printf('Chat %04d', 999-i), 1000+i FROM n`,
          params: [me.id]
        },
        {
          sql: `INSERT INTO media_assets(id, sha256, mime, width, height, byte_size, path, created_at)
          VALUES ('synthetic-cover', printf('%064d',0), 'image/png', 1, 1, 67, 'media/00/' || printf('%064d',0), 1)`
        },
        { sql: "INSERT INTO media_refs(media_id, owner_user_id) VALUES ('synthetic-cover', ?)", params: [me.id] },
        { sql: "UPDATE chats SET cover_media_id = 'synthetic-cover'" },
        {
          sql: `INSERT INTO forks (id, chat_id, parent_fork_id, created_at, pinned_at)
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<99)
        SELECT c.id || '-' || n.i, c.id, c.id, c.created_at+n.i,
          CASE WHEN n.i=1 AND c.created_at%10=0 THEN 1 END FROM chats c CROSS JOIN n`
        },
        {
          // The browse filter counts global chat pins, independently of branch pins above.
          sql: `INSERT INTO chat_pins (user_id, chat_id)
        SELECT owner_user_id, id FROM chats WHERE created_at%10=0`
        },
        {
          sql: `INSERT INTO fork_summaries (fork_id, chat_id, format, stamp, user_stamp, preview, messages, leaf, end_at, cast_json, joined_json, departed_json, activity_json)
        SELECT f.id, c.id, ?, c.shell_stamp, coalesce(u.stamp,0), 'Synthetic', c.created_at%100, NULL,
          c.created_at, '[]', '[]', '[]', '[]' FROM chats c JOIN forks f ON f.chat_id=c.id
          LEFT JOIN shell_user_stamps u ON u.user_id=c.owner_user_id`,
          params: [FORK_SUMMARY_FORMAT]
        }
      ])
      const view = {
        entity: null,
        chat: null,
        search: "",
        sort: "recent" as const,
        sections: [{ id: "chats" as const, limit: 20 }]
      }
      const sorts: Record<string, number> = {}
      for (const sort of CHAT_SORTS) {
        const started = performance.now()
        const result = yield* api.GetShellForks({ ...view, browse: { filter: "branches", sort, reversed: false } })
        const elapsed = performance.now() - started
        sorts[sort] = elapsed
        process.stdout.write(`Chats browse with pictures ${sort}, 100,000 branches: ${elapsed.toFixed(0)} ms\n`)
        if (process.env.SHELL_PICTURES_CONTROL !== "1")
          assert.isTrue(result.sections[0]!.rows.every((row) => row.chat.picture === "synthetic-cover"))
        assert.strictEqual(result.sections[0]!.total, 1000)
        assert.lengthOf(result.sections[0]!.rows, 20)
        assert.isTrue(result.sections[0]!.rows.every((f) => f.branches === 100 && f.current))
        assert.deepStrictEqual(result.filterCounts, {
          all: 1000,
          pinned: 100,
          groups: 0,
          solo: 0,
          branches: 1000,
          workshops: 0
        })
        assert.isBelow(JSON.stringify(result).length, 25_000)
        // Cold includes the existing shell materialization; warm sorts reuse it.
        assert.isBelow(elapsed, sort === "recent" ? 15_000 : 3000)
      }
      const warm: Array<number> = []
      for (let i = 0; i < 9; i++) {
        const start = performance.now()
        yield* api.GetShellForks(view)
        warm.push(performance.now() - start)
      }
      const measured = JSON.stringify({
        chats: 1000,
        branches: 100000,
        pictures: 1000,
        sorts,
        warmMs: warm,
        warmMedianMs: [...warm].sort((a, b) => a - b)[4]
      })
      process.stdout.write(`${measured}\n`)
      if (process.env.CHAT_BROWSE_SCALE_OUT) writeFileSync(process.env.CHAT_BROWSE_SCALE_OUT, `${measured}\n`)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  },
  120_000
)
