// Write handlers for ST import jobs (ARCHITECTURE.md §13): the rows the import page lists.
// Each is one small transaction; progress comes at most about once a second per job.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

export const makeStImportJobWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const handlers = {
    StImportJobStart: ({ userId, id, mode, source, root, prefix, filesTotal, bytesTotal, at }) =>
      Effect.gen(function* () {
        // The new run fences an earlier one (StImportBegin): an upload still marked running is over.
        yield* sql`UPDATE st_import_jobs SET status = 'interrupted', finished_at = ${at}, updated_at = ${at},
            current_file = NULL, error = 'Another import started before its files had all arrived.'
          WHERE owner_user_id = ${userId} AND status = 'running' AND mode = 'upload'`
        yield* sql`INSERT INTO st_import_jobs ${sql.insert({
          id,
          owner_user_id: userId,
          mode,
          source,
          root,
          prefix,
          status: "running",
          started_at: at,
          updated_at: at,
          files_total: filesTotal,
          bytes_total: bytesTotal
        })}`
      }).pipe(transaction(sql, "StImportJobStart")),

    StImportJobUpdate: (update) =>
      Effect.gen(function* () {
        const { userId, id, at, end } = update
        const rows = yield* sql`UPDATE st_import_jobs SET
            updated_at = ${at},
            files_total = ${update.filesTotal},
            files_done = ${update.filesDone},
            bytes_total = ${update.bytesTotal},
            bytes_done = ${update.bytesDone},
            current_file = ${end === undefined ? update.currentFile : null},
            counts_json = ${update.countsJson},
            attention = ${update.attention},
            report_json = coalesce(${update.reportJson ?? null}, report_json),
            not_sent_json = coalesce(${update.notSentJson ?? null}, not_sent_json),
            status = coalesce(${end?.status ?? null}, status),
            error = coalesce(${end?.error ?? null}, error),
            finished_at = ${end === undefined ? null : at}
          WHERE id = ${id} AND owner_user_id = ${userId} AND status = 'running' RETURNING id`
        return rows.length > 0
      }).pipe(transaction(sql, "StImportJobUpdate")),

    StImportJobReport: ({ userId, id, reportJson, countsJson, attention }) =>
      Effect.gen(function* () {
        const rows = yield* sql`UPDATE st_import_jobs SET report_json = ${reportJson}, counts_json = ${countsJson},
            attention = ${attention}
          WHERE id = ${id} AND owner_user_id = ${userId} RETURNING id`
        if (rows.length === 0) return yield* new NotFound({ entity: "import", id })
      }).pipe(transaction(sql, "StImportJobReport")),

    StImportJobsInterrupted: ({ at, error }) =>
      Effect.gen(function* () {
        const rows = yield* sql`UPDATE st_import_jobs SET status = 'interrupted', finished_at = ${at},
            updated_at = ${at}, current_file = NULL, error = ${error}
          WHERE status = 'running' RETURNING id`
        // What a confirmed re-import held for the file it was reading goes with its run.
        yield* sql`DELETE FROM st_import_stage`
        return rows.length
      }).pipe(transaction(sql, "StImportJobsInterrupted")),

    StImportJobSeen: ({ userId, id, at }) =>
      Effect.gen(function* () {
        const rows = yield* sql`UPDATE st_import_jobs SET seen_at = coalesce(seen_at, ${at})
          WHERE id = ${id} AND owner_user_id = ${userId} RETURNING id`
        if (rows.length === 0) return yield* new NotFound({ entity: "import", id })
      }).pipe(transaction(sql, "StImportJobSeen")),

    StImportJobsClear: ({ userId, id }) =>
      Effect.gen(function* () {
        const rows =
          id === null
            ? yield* sql`DELETE FROM st_import_jobs WHERE owner_user_id = ${userId} AND status <> 'running' RETURNING id`
            : yield* sql`DELETE FROM st_import_jobs
                WHERE owner_user_id = ${userId} AND id = ${id} AND status <> 'running' RETURNING id`
        return rows.length
      }).pipe(transaction(sql, "StImportJobsClear"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
  return handlers
})
