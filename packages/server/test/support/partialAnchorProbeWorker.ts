// Count insertion-anchor inspections in the actual partial endpoint statement.
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { Effect } from "effect"
import { writerConnection } from "../../src/db/connection.ts"
import { makeShellReadHandlers } from "../../src/db/shellReads.ts"

const { file, userId } = workerData as {
  file: string
  userId: Parameters<Effect.Success<typeof makeShellReadHandlers>["ShellMaterializePartial"]>[0]["userId"]
}
let visits = 0
const prepare = DatabaseSync.prototype.prepare
DatabaseSync.prototype.prepare = function (query) {
  if (query.includes("AS exact")) {
    this.function("count_anchor", { varargs: true }, (...values) => {
      visits++
      return values[0] ?? null
    })
    query = query.replaceAll("o.slot_depth", "count_anchor(o.slot_depth)")
  }
  return prepare.call(this, query)
}
await Effect.runPromise(
  Effect.flatMap(makeShellReadHandlers, (handlers) => handlers.ShellMaterializePartial({ userId })).pipe(
    Effect.provide(writerConnection(file)),
    Effect.scoped
  )
)
parentPort!.postMessage({ visits })
