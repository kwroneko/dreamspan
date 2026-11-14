// Deliberately attempt DDL on the production reader connection, in a worker only.
import { parentPort, workerData } from "node:worker_threads"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { readerConnection } from "../../src/db/connection.ts"

const probe = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const pragma = yield* sql.unsafe<{ query_only: number }>("PRAGMA query_only")
  const guarded = yield* Effect.exit(sql.unsafe("CREATE TABLE preview_write_probe (id INTEGER)"))
  yield* sql.unsafe("PRAGMA query_only = OFF")
  const fileGuarded = yield* Effect.exit(sql.unsafe("CREATE TABLE preview_write_probe_without_pragma (id INTEGER)"))
  return {
    queryOnly: pragma[0]!.query_only,
    guarded: Exit.isFailure(guarded),
    fileGuarded: Exit.isFailure(fileGuarded)
  }
})

Effect.runPromise(probe.pipe(Effect.provide(readerConnection(String(workerData.dbPath))), Effect.scoped)).then(
  (result) => {
    parentPort!.postMessage(result)
    parentPort!.close()
  },
  (error) => {
    throw error
  }
)
