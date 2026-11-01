// A revision's number along its first-parent line, from 1 for the first: what "changed since
// revision N" and History's "Revision N" count (owner, 2026-11-01).
import type { RevisionUse } from "@rp/shared/library.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

export const revisionNumber = (sql: SqlClient.SqlClient, revisionId: string) =>
  sql<{ n: number | null }>`
    WITH RECURSIVE line(id, n) AS (
      SELECT ${revisionId}, 1
      UNION ALL
      SELECT json_extract(r.parents, '$[0]'), l.n + 1 FROM entity_revisions r JOIN line l ON r.id = l.id
      WHERE json_extract(r.parents, '$[0]') IS NOT NULL
    )
    SELECT max(n) AS n FROM line`.pipe(Effect.map(([row]) => row?.n ?? 1))

/**
 * The reply a `generation` revision was cut for, from its `origin_ref`, with the chat's title
 * as it is now (only the user's own chat's: another's reads as gone).
 */
export const revisionUse = (sql: SqlClient.SqlClient, userId: string, originRef: string | null) =>
  Effect.gen(function* () {
    if (originRef === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(originRef)
    } catch {
      return null
    }
    const use = (parsed as { usedBy?: Omit<RevisionUse, "chatTitle"> } | null)?.usedBy
    if (use === undefined || typeof use.chatId !== "string") return null
    const [chat] = yield* sql<{ title: string | null }>`
      SELECT title FROM chats WHERE id = ${use.chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
    return { ...use, chatTitle: chat?.title ?? null } satisfies RevisionUse
  })
