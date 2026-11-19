// Probe the production path reader off the test runner's thread.
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { readerConnection } from "../../src/db/connection.ts"
import { lcmPath } from "../../src/db/lcmPath.ts"

const { file, userId, chatId, leaf } = workerData as {
  file: string
  userId: UserId
  chatId: string
  leaf: string
}
const queries: string[] = []
const prepare = DatabaseSync.prototype.prepare
DatabaseSync.prototype.prepare = function (query) {
  queries.push(query)
  return prepare.call(this, query)
}
Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const full = yield* lcmPath(sql, userId, chatId, leaf)
    queries.length = 0
    const inputs = yield* lcmPath(sql, userId, chatId, leaf, undefined, Number.MAX_SAFE_INTEGER, undefined, false)
    return { full, inputs, queries: [...queries] }
  }).pipe(Effect.provide(readerConnection(file)), Effect.scoped)
).then(
  (result) => parentPort!.postMessage(result),
  (error: unknown) => {
    throw error
  }
)
