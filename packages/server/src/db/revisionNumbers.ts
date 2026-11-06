// A revision's number along its line, from 1 for the first: what "changed since revision N"
// and History's "Revision N" count (owner, 2026-11-01). A fork's line runs on through the
// revisions it was forked from, as a git branch's log does (owner, 2026-11-06), so its numbers
// continue its original's.
import type { RevisionUse } from "@rp/shared/library.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

/**
 * The revision before `r` (an `entity_revisions` alias) on its line: its first parent, or, for
 * a fork's first revision, the revision it was forked from (another entity's, and that one's
 * own line continues the same way, back to the first fork's original).
 */
export const previousRevisionSql = (r: string) =>
  `coalesce(json_extract(${r}.parents, '$[0]'), (SELECT e.forked_from_revision_id FROM entities e
    WHERE e.id = ${r}.entity_id AND json_array_length(${r}.parents) = 0
      AND e.forked_from_revision_id = CASE WHEN json_valid(${r}.origin_ref)
        THEN json_extract(${r}.origin_ref, '$.forked') END))`

/** Membership follows the copied revision, not every revision of an ancestor entity. */
export const revisionOnLine = (sql: SqlClient.SqlClient, head: string, revisionId: string) =>
  sql<{ found: number }>`
    WITH RECURSIVE line(id) AS (
      SELECT ${head}
      UNION
      SELECT ${sql.literal(previousRevisionSql("r"))} FROM entity_revisions r JOIN line l ON r.id = l.id
      WHERE l.id <> ${revisionId} AND ${sql.literal(previousRevisionSql("r"))} IS NOT NULL
    )
    SELECT EXISTS(SELECT 1 FROM line WHERE id = ${revisionId}) AS found`.pipe(Effect.map(([row]) => row!.found === 1))

export const revisionNumber = (sql: SqlClient.SqlClient, revisionId: string) =>
  sql<{ n: number | null }>`
    WITH RECURSIVE line(id, n) AS (
      SELECT ${revisionId}, 1
      UNION ALL
      SELECT ${sql.literal(previousRevisionSql("r"))}, l.n + 1 FROM entity_revisions r JOIN line l ON r.id = l.id
      WHERE ${sql.literal(previousRevisionSql("r"))} IS NOT NULL
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
