// Which chats the account sees (DESIGN §2.1): a pending chat, the new-chat page's chat before
// its first turn, is reachable only by its id, so it affects nothing until it is committed.
// Every reader that reaches across the user's chats uses one of these, and
// test/chatReaders.test.ts fails on a new one that doesn't.
// Readers of one chat by its id keep `deleted_at IS NULL` alone: the chat's own page reads it.
import type { SqlClient } from "effect/sql"

/** A live, committed chat, as SQL text over the chats row `alias`. */
export const listedSql = (alias: string) => `${alias}.deleted_at IS NULL AND ${alias}.status <> 'pending'`

/** `listedSql` as a fragment. */
export const listed = (sql: SqlClient.SqlClient, alias: string) => sql.literal(listedSql(alias))

/**
 * A committed chat, deleted or not, as SQL text: for readers that see the bin's chats too
 * (an import check's stamps, say).
 */
export const committedSql = (alias: string) => `${alias}.status <> 'pending'`

/** `committedSql` as a fragment. */
export const committed = (sql: SqlClient.SqlClient, alias: string) => sql.literal(committedSql(alias))

/**
 * A listed chat, or the one named `chatId` even while pending: for a reader that reads across
 * the account, or one chat for that chat's own page.
 */
export const listedOr = (sql: SqlClient.SqlClient, alias: string, chatId: string | null) =>
  sql`(${sql.literal(alias)}.deleted_at IS NULL AND (${sql.literal(alias)}.status <> 'pending' OR ${sql.literal(alias)}.id = ${chatId}))`
