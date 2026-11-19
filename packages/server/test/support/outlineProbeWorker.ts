// Compare the public split/preview projection with complete shell summaries off-thread.
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { ForkRow } from "../../src/db/rows.ts"
import { readerConnection } from "../../src/db/connection.ts"
import { chatForkSummaries, computeForkSummaries } from "../../src/db/forkSummaries.ts"

const { file, userId, chatId } = workerData as { file: string; userId: UserId; chatId: string }
const queries: string[] = []
let capture = false
const prepare = DatabaseSync.prototype.prepare
DatabaseSync.prototype.prepare = function (query) {
  if (capture) queries.push(query)
  return prepare.call(this, query)
}
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const records = yield* sql<ForkRow>`SELECT * FROM forks WHERE chat_id=${chatId}`
    capture = true
    const actual = [...(yield* chatForkSummaries(sql, userId, chatId, records))]
    capture = false
    const expected = (yield* computeForkSummaries(sql, records)).map((summary) => [
      summary.forkId,
      {
        endAt: summary.endAt,
        split: summary.split,
        preview: summary.preview,
        // The stored macro behind a greeting-preview row (rowmacro2), read beside the preview.
        previewMacro: summary.previewMacro,
        threads: summary.threads
      }
    ])
    return { actual, expected, queries }
  }).pipe(Effect.provide(readerConnection(file)), Effect.scoped)
)
parentPort!.postMessage(result)
