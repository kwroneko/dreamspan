// Read handlers for the ST data folder import (ARCHITECTURE.md §13): what earlier imports
// made, so a re-run updates it instead of importing it twice.
import type { ChatId, EntityId, ForkId, SlotId } from "@rp/shared/chat.ts"
import type { EntityKind, RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { type ReadOps, ST_CHAT_RECORD } from "./ops.ts"
import { query } from "./tx.ts"

export const makeStImportReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const handlers = {
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
