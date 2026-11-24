// Writer-only guard overhead on synthetic transactions; a rollback restores each sample.
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { claimAutoTurn, settleAutoRuns, trackAutoRuns } from "../src/db/autoGuard.ts"
import { writerConnection } from "../src/db/connection.ts"
import { migrate, migrationDefinitions } from "../src/db/migrations.ts"
import { settleSummaries, trackSummaryTouches } from "../src/db/summaryValidity.ts"
import { tempDir } from "./support/tempDir.ts"

it.live(
  "measures append, edit, import and delete guard cost for 1,000 synthetic messages",
  () =>
    Effect.gen(function* () {
      for (const mode of ["baseline", "idle", "same-chat", "other-chat"] as const) {
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* migrate(migrationDefinitions)
          yield* trackSummaryTouches(sql)
          if (mode !== "baseline") yield* trackAutoRuns(sql)
          yield* sql`INSERT INTO users (id,handle,display_name,role,created_at) VALUES ('u','u','U','admin',1)`
          for (const id of ["chat", "other"])
            yield* sql`INSERT INTO chats (id,owner_user_id,kind,status,created_at) VALUES (${id},'u','rp','active',1)`
          const batch = (prefix: string, n: number) =>
            Effect.gen(function* () {
              yield* sql.unsafe(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i < ${n - 1})
          INSERT INTO version_records (id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at,authoring_fork_id)
          SELECT '${prefix}v'||i, '${prefix}s'||i, 0, 'complete','human','Synthetic','verbatim','user_written',1,1,'chat' FROM n`)
              yield* sql.unsafe(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i < ${n - 1})
          INSERT INTO slots (id,chat_id,parent_slot_id,depth,selected_version_id,created_at)
          SELECT '${prefix}s'||i,'chat',CASE WHEN i=0 THEN ${prefix === "base" ? "NULL" : "'bases999'"} ELSE '${prefix}s'||(i-1) END,i+${prefix === "base" ? 0 : 1000},'${prefix}v'||i,1 FROM n`)
              yield* sql`UPDATE forks SET tip_slot_id = ${`${prefix}s${n - 1}`} WHERE id = 'chat'`
            })
          yield* batch("base", 1000).pipe(sql.withTransaction)
          yield* settleSummaries(sql)
          if (mode !== "baseline") yield* settleAutoRuns(sql, "Fixture")
          if (mode === "same-chat" || mode === "other-chat") {
            const chatId = mode === "same-chat" ? "chat" : "other"
            yield* claimAutoTurn(sql, { userId: "u", chatId, forkId: chatId }, null, {
              slotId: "bases999",
              versionId: "basev999"
            })
          }
          const operations = {
            append: batch("append", 1),
            edit: sql`UPDATE version_records SET content = 'Edited' WHERE id = 'basev500'`,
            import1000: batch("import", 1000),
            delete1000: Effect.gen(function* () {
              yield* sql`UPDATE forks SET tip_slot_id = NULL WHERE id = 'chat'`
              yield* sql`DELETE FROM versions WHERE slot_id IN (SELECT id FROM slots WHERE chat_id = 'chat')`
              yield* sql`DELETE FROM slots WHERE chat_id = 'chat'`
            })
          }
          for (const [operation, body] of Object.entries(operations)) {
            const times: number[] = []
            for (let i = 0; i < 8; i++) {
              const began = performance.now()
              yield* Effect.gen(function* () {
                yield* body
                yield* settleSummaries(sql)
                if (mode !== "baseline") yield* settleAutoRuns(sql, operation)
                return yield* Effect.fail("rollback sample")
              }).pipe(
                sql.withTransaction,
                Effect.catch((error) => (error === "rollback sample" ? Effect.void : Effect.fail(error)))
              )
              if (i > 0) times.push(performance.now() - began)
            }
            times.sort((a, b) => a - b)
            const row = JSON.stringify({ mode, operation, medianMs: times[3], samplesMs: times })
            console.log(row)
            if (process.env.AUTO_GUARD_COST_LOG) appendFileSync(process.env.AUTO_GUARD_COST_LOG, row + "\n")
          }
        }).pipe(Effect.provide(writerConnection(join(tempDir("auto-cost"), "db.sqlite"))))
      }
    }),
  { timeout: 120_000, tags: ["slow"] }
)
