// Count actual full-tree executions for concurrent views, through the production
// materialization coordinator and worker handler, with SQLite off the main thread.
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { Effect } from "effect"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { readerConnection } from "../../src/db/connection.ts"
import { makeShellReadHandlers } from "../../src/db/shellReads.ts"
import { makeShellMaterialization } from "../../src/db/shellMaterialization.ts"
import { cardsView, forksView, libraryView, snapshotState } from "../../src/db/shellViews.ts"

const { file, userId } = workerData as { file: string; userId: UserId }
let capture = false
let executions = 0
let materializations = 0
const prepare = DatabaseSync.prototype.prepare
DatabaseSync.prototype.prepare = function (text) {
  const statement = prepare.call(this, text)
  const all = statement.all
  statement.all = function (...args) {
    // A walk: a chat's whole slot tree (the batch path resolver's read, db/forkPaths.ts) or the
    // paths of a few forks alone (`shellSlotsQuery` with evidence).
    if (
      capture &&
      (text.includes("CROSS JOIN slots s ON s.chat_id = j.value") ||
        (text.includes("WITH RECURSIVE views AS MATERIALIZED") && text.includes("version_participants")))
    )
      executions++
    return Reflect.apply(all, this, args)
  }
  return statement
}

const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const shared = yield* makeShellMaterialization((id: UserId) =>
        Effect.gen(function* () {
          materializations++
          const handlers = yield* makeShellReadHandlers
          return snapshotState(yield* handlers.ShellMaterialize({ userId: id }))
        }).pipe(Effect.provide(readerConnection(file)), Effect.scoped)
      )
      const view = {
        entity: null,
        chat: null,
        search: "",
        sort: "recent" as const,
        sections: [{ id: "all" as const, limit: 100 }]
      }
      capture = true
      const [cards, forks, library] = yield* Effect.all(
        [
          shared.get(userId).pipe(Effect.map(({ state }) => cardsView(state))),
          shared.get(userId).pipe(Effect.map(({ state, labels }) => forksView(state, view, labels))),
          shared.get(userId).pipe(Effect.map(({ state }) => libraryView(state)))
        ],
        { concurrency: "unbounded" }
      )
      capture = false
      const expected = yield* Effect.gen(function* () {
        const handlers = yield* makeShellReadHandlers
        return {
          cards: yield* handlers.ShellCards({ userId }),
          forks: yield* handlers.ShellForks({ userId, view }),
          library: yield* handlers.ShellLibrary({ userId })
        }
      }).pipe(Effect.provide(readerConnection(file)), Effect.scoped)
      return { executions, materializations, actual: { cards, forks, library }, expected }
    })
  )
)
parentPort!.postMessage(result)
