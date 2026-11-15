// A part's kept tree (db/shellReads.ts, `ShellSummarizeStale`), off-thread on a read-only
// connection: reads every live fork's paths once and reports the chat's stamp; after the test
// has written, walks the forks no write has reached since (their `fork_shell_stamps` at or
// before that stamp) from the kept tree, and each of them alone by the per-fork SQL path.
import { parentPort, workerData } from "node:worker_threads"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { ForkRow } from "../../src/db/rows.ts"
import { readerConnection } from "../../src/db/connection.ts"
import { computeForkSummaries, makePathResolver } from "../../src/db/forkSummaries.ts"

const { file, chatId } = workerData as { file: string; chatId: string }
const live = (sql: SqlClient.SqlClient) =>
  sql<ForkRow & { fork_stamp: number }>`SELECT f.*,
      coalesce((SELECT stamp FROM fork_shell_stamps WHERE fork_id = f.id), 0) AS fork_stamp
    FROM forks f WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL ORDER BY f.id`
await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [chat] = yield* sql<{ stamp: number }>`SELECT shell_stamp AS stamp FROM chats WHERE id = ${chatId}`
    const stamp = chat!.stamp
    const resolver = makePathResolver(sql, true)
    yield* resolver.paths(yield* live(sql))
    parentPort!.postMessage({ read: stamp })
    yield* Effect.promise(() => new Promise((resolve) => parentPort!.once("message", resolve)))
    const records = yield* live(sql)
    const kept = records.filter((record) => record.fork_stamp <= stamp)
    const sorted = <A extends { readonly forkId: string }>(list: ReadonlyArray<A>) =>
      [...list].sort((a, b) => (a.forkId < b.forkId ? -1 : 1))
    const resolved = sorted(yield* computeForkSummaries(sql, kept, false, resolver))
    const walked = sorted(
      yield* Effect.forEach(kept, (record) => computeForkSummaries(sql, [record], true)).pipe(
        Effect.map((parts) => parts.flat())
      )
    )
    parentPort!.postMessage({ forks: records.length, kept: kept.length, resolved, walked })
  }).pipe(Effect.provide(readerConnection(file)), Effect.scoped)
)
