// Inspect the real settlement statement on a worker connection, with sparse touches.
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { writerConnection } from "../../src/db/connection.ts"
import { settleSummaries, trackSummaryTouches } from "../../src/db/summaryValidity.ts"

const { file, chatId, versionId } = workerData as { file: string; chatId: string; versionId: string }
const prepare = DatabaseSync.prototype.prepare
let plan: string[] = []
DatabaseSync.prototype.prepare = function (query) {
  const statement = prepare.call(this, query)
  if (/kept\(chat_id, stamp\) AS MATERIALIZED/.test(query)) {
    const explain = prepare.call(this, `EXPLAIN QUERY PLAN ${query}`)
    statement.all = new Proxy(statement.all, {
      apply(target, receiver, args) {
        const rows = Reflect.apply(explain.all, explain, args) as Array<Record<string, unknown>>
        plan = rows.map((row) => String(row.detail))
        return Reflect.apply(target, receiver, args)
      }
    })
  }
  return statement
}
await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* trackSummaryTouches(sql)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO shell_moved SELECT id,shell_stamp FROM chats WHERE id=${chatId}`
        yield* sql`INSERT INTO shell_touches(kind,chat_id,ref) VALUES('text',${chatId},${versionId})`
        yield* settleSummaries(sql)
      })
    )
  }).pipe(Effect.provide(writerConnection(file)), Effect.scoped)
)
parentPort!.postMessage(plan)
