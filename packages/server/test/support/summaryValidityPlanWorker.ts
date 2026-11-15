// Inspect the actual settlement statements on the complete schema, off the test thread.
import { parentPort } from "node:worker_threads"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { writerConnection } from "../../src/db/connection.ts"
import { migrations } from "../../src/db/migrations.ts"
import { settleSummaries, trackSummaryTouches } from "../../src/db/summaryValidity.ts"

const plans = await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
    yield* trackSummaryTouches(sql)
    yield* sql`INSERT INTO shell_moved(chat_id, stamp) VALUES ('synthetic', 1)`
    const plans: Array<ReadonlyArray<{ detail: string }>> = []
    const inspected = new Proxy(sql, {
      apply(target, self, args) {
        const statement = Reflect.apply(target, self, args) as ReturnType<typeof sql.unsafe>
        const [query, bindings] = statement.compile()
        if (!query.includes("INSERT INTO shell_touches") && !query.includes("INSERT INTO fork_shell_stamps"))
          return statement
        return sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, bindings).pipe(
          Effect.tap((rows) => Effect.sync(() => plans.push(rows))),
          Effect.as([])
        )
      }
    })
    yield* settleSummaries(inspected)
    return plans
  }).pipe(Effect.provide(writerConnection(":memory:")), Effect.scoped)
)
parentPort!.postMessage(plans)
