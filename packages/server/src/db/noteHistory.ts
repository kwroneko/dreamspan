// Immutable summary ancestry and path reads, shared by assembly and the chat editor.
import type { Doc } from "@dreamspan/shared/library.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

export const noteHistory = (sql: SqlClient.SqlClient, userId: string, chatId: string) => ({
  // A revision's first parents, which never change: the same from a pinned revision.
  noteHistory: (entity: string, revision: string, limit: number) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ id: string; doc_json: string }>`
          WITH RECURSIVE chain(id, n) AS (
            SELECT v.id, 1 FROM entity_revisions v JOIN entities e ON e.id = v.entity_id
            WHERE v.id = ${revision} AND v.entity_id = ${entity} AND e.owner_user_id = ${userId} AND e.kind = 'note'
            UNION ALL
            SELECT json_extract(v.parents, '$[0]'), c.n + 1 FROM entity_revisions v JOIN chain c ON v.id = c.id
            WHERE json_extract(v.parents, '$[0]') IS NOT NULL AND c.n < ${limit}
          )
          SELECT v.id, v.doc_json FROM chain c JOIN entity_revisions v ON v.id = c.id
          WHERE v.entity_id = ${entity} ORDER BY c.n`
      return rows.map((row) => ({ revision: row.id, doc: JSON.parse(row.doc_json) as Doc }))
    }),

  // The path's slots never change their parents: the same on a rebuild.
  onPath: (leaf: string | null, slots: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (leaf === null || slots.length === 0) return new Set<string>()
      const rows = yield* sql<{ id: string }>`
          WITH RECURSIVE path(id) AS (
            SELECT id FROM slots WHERE id = ${leaf} AND chat_id = ${chatId} AND EXISTS (SELECT 1 FROM chats o WHERE o.id = ${chatId} AND o.owner_user_id = ${userId})
            UNION ALL
            SELECT s.parent_slot_id FROM slots s JOIN path p ON s.id = p.id WHERE s.parent_slot_id IS NOT NULL
          )
          SELECT id FROM path WHERE id IN ${sql.in([...slots])}`
      return new Set(rows.map((row) => row.id))
    })
})
