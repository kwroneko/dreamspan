// The recorded state changes on a branch's path, for the timeline's change markers (DESIGN §3.4;
// client `features/chat/stateMarkers.ts`): the events of the keys the client's marker kinds
// read, as they apply on the fork's display path through the leaf (the same visibility,
// suppression and version rules as every state read, `stateRead.ts`), where each was written,
// and the names of what they name. Display only: nothing here is read by assembly, summaries or
// exports. The cost is the path's segments and those events, then one lookup per kind of id.
import type { StateMarks } from "@rp/shared/contextsApi.ts"
import { stateKeyDeclaration } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type ReadOps } from "./ops.ts"
import { markEventsThrough } from "./stateRead.ts"
import { query } from "./tx.ts"

type Table = "entity" | "ref" | "connection" | "model"

/** The ids a value holds, by the table its key's declaration says each field names. */
const idsOf = (key: string, value: unknown, into: Record<Table, Set<string>>) => {
  const declared = stateKeyDeclaration(key)?.ids
  if (declared === undefined || typeof value !== "object" || value === null) return
  for (const [field, id] of Object.entries(declared)) {
    if (id === undefined || !(id.table in into)) continue
    const held = (value as Record<string, unknown>)[field]
    for (const one of Array.isArray(held) ? held : [held]) if (typeof one === "string") into[id.table as Table].add(one)
  }
}

export const makeStateMarkReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    StateMarks: ({ userId, chatId, forkId, slotId, keys }) =>
      Effect.gen(function* () {
        const [fork] = yield* sql<{ readonly id: string }>`
          SELECT f.id FROM forks f JOIN chats c ON c.id = f.chat_id
          WHERE f.id = ${forkId} AND f.chat_id = ${chatId} AND f.deleted_at IS NULL
            AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!fork) return yield* new NotFound({ entity: "fork", id: forkId })
        if (keys.length === 0) return { events: [], names: {}, notes: {} }
        const rows = yield* markEventsThrough(sql, chatId, slotId, fork.id, [...new Set(keys)])
        const ids: Record<Table, Set<string>> = {
          entity: new Set(),
          ref: new Set(),
          connection: new Set(),
          model: new Set()
        }
        const events = rows.map((row) => {
          const value = JSON.parse(row.value_json) as unknown
          idsOf(row.key, value, ids)
          // A participant's scope is a card; a role's names nothing.
          if (row.scope !== null) ids.entity.add(row.scope)
          return {
            eventId: row.id,
            slotId: row.slot_id as StateMarks["events"][number]["slotId"],
            versionId: row.version_id,
            origin: row.origin,
            scope: row.scope,
            key: row.key,
            value
          }
        })
        const names: Record<string, string> = {}
        const notes: Record<string, StateMarks["notes"][string]> = {}
        // Only the user's own, and nothing deleted for good: a change that names such a thing shows no name.
        if (ids.entity.size > 0) {
          const found = yield* sql<{
            readonly id: string
            readonly kind: string
            readonly label: string
            readonly card: string | null
            readonly on_by_default: number | null
            readonly move_group: string | null
          }>`
            SELECT e.id, e.kind, r.label,
              CASE WHEN e.kind = 'note' THEN json_extract(v.doc_json, '$.owner.card') END AS card,
              CASE WHEN e.kind = 'note' THEN json_extract(v.doc_json, '$.on_by_default') END AS on_by_default,
              CASE WHEN e.kind = 'note' THEN json_extract(v.doc_json, '$.move_group') END AS move_group
            FROM entities e JOIN entity_refs r ON r.entity_id = e.id
              JOIN entity_revisions v ON v.id = r.head_revision_id
            WHERE e.id IN ${sql.in([...ids.entity])} AND e.owner_user_id = ${userId} AND e.purged_at IS NULL`
          for (const row of found) {
            names[row.id] = row.label
            if (row.kind === "note")
              notes[row.id] = {
                card: typeof row.card === "string" ? row.card : null,
                onByDefault: row.on_by_default === 1,
                group: typeof row.move_group === "string" ? row.move_group : null
              }
          }
        }
        if (ids.ref.size > 0) {
          const found = yield* sql<{ readonly id: string; readonly label: string }>`
            SELECT r.id, r.label FROM entity_refs r JOIN entities e ON e.id = r.entity_id
            WHERE r.id IN ${sql.in([...ids.ref])} AND e.owner_user_id = ${userId} AND e.purged_at IS NULL`
          for (const row of found) names[row.id] = row.label
        }
        if (ids.connection.size > 0) {
          const found = yield* sql<{ readonly id: string; readonly name: string }>`
            SELECT id, name FROM connections
            WHERE id IN ${sql.in([...ids.connection])} AND owner_user_id = ${userId}`
          for (const row of found) names[row.id] = row.name
        }
        if (ids.model.size > 0) {
          const found = yield* sql<{ readonly id: string; readonly model_key: string }>`
            SELECT m.id, m.model_key FROM models m JOIN connections c ON c.id = m.connection_id
            WHERE m.id IN ${sql.in([...ids.model])} AND c.owner_user_id = ${userId}`
          for (const row of found) names[row.id] = row.model_key
        }
        return { events, names, notes }
      }).pipe(query("StateMarks"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
