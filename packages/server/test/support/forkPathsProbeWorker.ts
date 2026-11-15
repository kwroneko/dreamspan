// Each live fork's summary two ways, off-thread on a read-only connection: resolved from one
// read of each chat's tree (db/forkPaths.ts, a batch of more than eight forks of a chat) and walked alone
// by the per-fork SQL path (`shellSlotsQuery`, as a refresh of one or two forks reads it); and
// the path and event rows themselves, from the resolver and from `shellSlotsQuery`/`shellEventsQuery`.
import { parentPort, workerData } from "node:worker_threads"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { ForkRow } from "../../src/db/rows.ts"
import { readerConnection } from "../../src/db/connection.ts"
import { computeForkOutlines, computeForkSummaries, makePathResolver } from "../../src/db/forkSummaries.ts"
import { shellEventsQuery, shellSlotsQuery } from "../../src/db/shellQueries.ts"

const { file } = workerData as { file: string }
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const records = yield* sql<ForkRow>`SELECT f.* FROM forks f JOIN chats c ON c.id = f.chat_id
      WHERE f.deleted_at IS NULL AND c.deleted_at IS NULL ORDER BY f.id`
    const sorted = <A extends { readonly forkId: string }>(list: ReadonlyArray<A>) =>
      [...list].sort((a, b) => (a.forkId < b.forkId ? -1 : 1))
    const resolved = sorted(yield* computeForkSummaries(sql, records, false))
    const walked = sorted(
      yield* Effect.forEach(records, (record) => computeForkSummaries(sql, [record], true)).pipe(
        Effect.map((parts) => parts.flat())
      )
    )
    const outlines = sorted(yield* computeForkOutlines(sql, records))
    const walkedOutlines = sorted(
      yield* Effect.forEach(records, (record) => computeForkOutlines(sql, [record])).pipe(
        Effect.map((parts) => parts.flat())
      )
    )
    // The rows themselves, so an event or slot no summary field happens to show still counts.
    const canonical = (row: object) => JSON.stringify(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1)))
    const resolver = makePathResolver(sql, true)
    const ids = records.map((r) => r.id)
    const resolvedPaths = yield* resolver.paths(records)
    const resolvedEvents = yield* resolver.events(records)
    // A resolved row shared by several forks names the first (PathSlot.fork_id); the map's key is the fork.
    const paths = ids.map((id) => (resolvedPaths.get(id) ?? []).map((row) => canonical({ ...row, fork_id: id })))
    const events = ids.map((id) => resolvedEvents.filter((e) => e.fork_id === id).map(canonical))
    const pathRows = yield* sql.unsafe<{ fork_id: string }>(shellSlotsQuery, [JSON.stringify(ids)])
    const eventRows = yield* sql.unsafe<{ fork_id: string }>(shellEventsQuery, [JSON.stringify(ids)])
    const walkedPaths = ids.map((id) => pathRows.filter((r) => r.fork_id === id).map(canonical))
    const walkedEvents = ids.map((id) => eventRows.filter((r) => r.fork_id === id).map(canonical))
    const perChat = new Map<string, number>()
    for (const record of records) perChat.set(record.chat_id, (perChat.get(record.chat_id) ?? 0) + 1)
    return {
      forks: records.length,
      chatForks: Math.max(...perChat.values()),
      resolved,
      walked,
      outlines,
      walkedOutlines,
      paths,
      walkedPaths,
      events,
      walkedEvents
    }
  }).pipe(Effect.provide(readerConnection(file)), Effect.scoped)
)
parentPort!.postMessage(result)
