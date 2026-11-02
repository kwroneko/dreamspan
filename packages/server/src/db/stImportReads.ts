// Read handlers for the ST data folder import (ARCHITECTURE.md §13): what earlier imports
// made, so a re-run updates it instead of importing it twice.
import type { ChatId, EntityId, ForkId, SlotId } from "@rp/shared/chat.ts"
import type { EntityKind, RefId } from "@rp/shared/library.ts"
import { StCount, StImportJob, type StImportStatus } from "@rp/shared/stImportApi.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type ReadOps, ST_CHAT_RECORD } from "./ops.ts"
import { computeForkSummaries } from "./forkSummaries.ts"
import type { ForkRow } from "./rows.ts"
import { query } from "./tx.ts"

/** An import job's row, as the import page lists it (st_import_jobs). */
interface JobRow {
  readonly id: string
  readonly mode: "path" | "upload"
  readonly source: string
  readonly status: StImportStatus
  readonly started_at: number
  readonly finished_at: number | null
  readonly updated_at: number
  readonly seen_at: number | null
  readonly files_total: number
  readonly files_done: number
  readonly bytes_total: number
  readonly bytes_done: number
  readonly current_file: string | null
  readonly counts_json: string
  readonly attention: number
  readonly error: string | null
}

const JOB_COLUMNS = `id, mode, source, status, started_at, finished_at, updated_at, seen_at, files_total, files_done,
  bytes_total, bytes_done, current_file, counts_json, attention, error`

const jobOf = (row: JobRow) =>
  new StImportJob({
    id: row.id,
    mode: row.mode,
    source: row.source,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
    filesTotal: row.files_total,
    filesDone: row.files_done,
    bytesTotal: row.bytes_total,
    bytesDone: row.bytes_done,
    currentFile: row.current_file,
    counts: Object.fromEntries(
      Object.entries(JSON.parse(row.counts_json) as Record<string, StCount>).map(([kind, count]) => [
        kind,
        new StCount(count)
      ])
    ),
    attention: row.attention,
    error: row.error,
    seen: row.seen_at !== null
  })

export const makeStImportReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const handlers = {
    ListStImportJobs: ({ userId }) =>
      Effect.map(
        sql<JobRow>`SELECT ${sql.literal(JOB_COLUMNS)} FROM st_import_jobs WHERE owner_user_id = ${userId}
          ORDER BY started_at DESC, id DESC LIMIT 200`,
        (rows) => rows.map(jobOf)
      ).pipe(query("ListStImportJobs")),
    GetStImportJob: ({ userId, id }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<
          JobRow & { root: string | null; prefix: string; report_json: string | null; not_sent_json: string }
        >`SELECT ${sql.literal(JOB_COLUMNS)}, root, prefix, report_json, not_sent_json FROM st_import_jobs
          WHERE owner_user_id = ${userId} AND id = ${id}`
        if (row === undefined) return yield* new NotFound({ entity: "import", id })
        return {
          job: jobOf(row),
          root: row.root,
          prefix: row.prefix,
          reportJson: row.report_json,
          notSentJson: row.not_sent_json
        }
      }).pipe(query("GetStImportJob")),
    StImportLatestChat: ({ userId }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ id: string; title: string; created_at: number; current_fork_id: string | null }>`
          SELECT c.id, c.title, c.created_at, c.current_fork_id FROM jobs j
          JOIN chats c ON c.id = json_extract(j.payload_json, '$.chatId') AND c.owner_user_id = ${userId}
          WHERE j.owner_user_id = ${userId} AND j.kind = ${ST_CHAT_RECORD} AND c.deleted_at IS NULL
            AND c.status = 'active'
          ORDER BY c.last_message_at DESC, c.id DESC LIMIT 1`
        if (row === undefined) return null
        // Its characters in its current fork, as the shell names it (the cast less who you play).
        const forks = yield* sql<ForkRow>`SELECT * FROM forks WHERE id = ${row.current_fork_id}`
        const [summary] = yield* computeForkSummaries(sql, forks)
        const cast = summary?.cast ?? []
        const labels =
          cast.length === 0
            ? []
            : yield* sql<{ entity_id: string; label: string }>`SELECT entity_id, label FROM entity_refs
                WHERE ref_kind = 'upstream' AND ${sql.in("entity_id", cast)}`
        const byId = new Map(labels.map((ref) => [ref.entity_id, ref.label]))
        return {
          chatId: row.id as ChatId,
          title: row.title,
          createdAt: row.created_at,
          names: cast.flatMap((id) => {
            const label = byId.get(id)
            return label === undefined ? [] : [label]
          })
        }
      }).pipe(query("StImportLatestChat")),
    StImportSources: ({ userId }) =>
      Effect.gen(function* () {
        const records = yield* sql<{ id: string; status: string; payload_json: string; deleted_at: number | null }>`
          SELECT j.id, j.status, j.payload_json, coalesce(c.deleted_at, f.deleted_at) AS deleted_at FROM jobs j
          JOIN chats c ON c.id = json_extract(j.payload_json, '$.chatId') AND c.owner_user_id = ${userId}
          LEFT JOIN forks f ON f.id = json_extract(j.payload_json, '$.forkId')
          WHERE j.owner_user_id = ${userId} AND j.kind = ${ST_CHAT_RECORD}
          ORDER BY j.id`
        const library = yield* sql<{
          ref_id: string
          entity_id: string
          kind: EntityKind
          label: string
          source_path: string
          source_hash: string | null
          deleted_at: number | null
        }>`
          SELECT r.id AS ref_id, e.id AS entity_id, e.kind, r.label, r.source_path, r.source_hash, e.deleted_at
          FROM entity_refs r JOIN entities e ON e.id = r.entity_id
          WHERE e.owner_user_id = ${userId} AND r.ref_kind = 'upstream' AND r.source_path IS NOT NULL
            AND e.kind IN ('card', 'lorebook', 'preset')
          ORDER BY r.id`
        return {
          chats: records.map((row) => {
            const payload = JSON.parse(row.payload_json) as {
              forkId?: ForkId
              source: string
              chatId: ChatId
              state?: string
              notes?: Record<string, EntityId>
              end?: SlotId | null
              merged?: boolean
              firstAdded?: SlotId | null
            }
            return {
              forkId: payload.forkId ?? (String(payload.chatId) as ForkId),
              recordId: row.id,
              source: payload.source,
              chatId: payload.chatId,
              complete: row.status === "complete",
              binned: row.deleted_at !== null,
              stateJson: payload.state ?? "null",
              notes: payload.notes ?? {},
              end: payload.end ?? null,
              merged: payload.merged ?? false,
              firstAdded: payload.firstAdded ?? null
            }
          }),
          library: library.map((row) => ({
            refId: row.ref_id as RefId,
            entityId: row.entity_id as EntityId,
            kind: row.kind,
            label: row.label,
            sourcePath: row.source_path,
            sourceHash: row.source_hash,
            binned: row.deleted_at !== null
          }))
        }
      }).pipe(query("StImportSources"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
