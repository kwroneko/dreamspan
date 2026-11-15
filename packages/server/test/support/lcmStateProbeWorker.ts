// Count production input reads on a fresh reader, off the main thread.
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { Effect } from "effect"
import { readerConnection } from "../../src/db/connection.ts"
import { makeLcmUiReadHandlers } from "../../src/db/lcmUiReads.ts"

const { file, payload } = workerData as {
  file: string
  payload: Parameters<Effect.Success<typeof makeLcmUiReadHandlers>["GetLcmState"]>[0]
}
let inputReads = 0
const prepare = DatabaseSync.prototype.prepare
DatabaseSync.prototype.prepare = function (query) {
  const statement = prepare.call(this, query)
  if (query.includes("AS inputs_json")) {
    statement.all = new Proxy(statement.all, {
      apply(target, self, args) {
        inputReads++
        return Reflect.apply(target, self, args)
      }
    })
  }
  return statement
}
const state = await Effect.runPromise(
  Effect.flatMap(makeLcmUiReadHandlers, (handlers) => handlers.GetLcmState(payload)).pipe(
    Effect.provide(readerConnection(file)),
    Effect.scoped
  )
)
parentPort!.postMessage({ state, inputReads })
