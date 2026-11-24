import { chatKinds } from "@dreamspan/shared/chatKinds.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { NotFound } from "@dreamspan/shared/errors.ts"

type Feature = "allowsSummaries" | "allowsMerge"

/** Whether the chat's kind allows `feature`, whatever its status. Unknown kinds fail closed. */
export const kindAllows = (sql: SqlClient.SqlClient, chatId: string, feature: Feature) =>
  Effect.map(
    sql<{ kind: string }>`SELECT kind FROM chats WHERE id = ${chatId}`,
    ([row]) => row !== undefined && chatKinds.get(row.kind)?.[feature] === true
  )

/**
 * Callers establish ownership before using this internal policy lookup. Unknown kinds fail closed,
 * and so does a pending chat (the new-chat page's, before its first turn): it summarizes and
 * merges nothing until it is committed.
 */
export const chatAllows = (sql: SqlClient.SqlClient, chatId: string, feature: Feature) =>
  Effect.map(
    sql<{ kind: string; status: string }>`SELECT kind, status FROM chats WHERE id = ${chatId}`,
    ([row]) => row !== undefined && row.status !== "pending" && chatKinds.get(row.kind)?.[feature] === true
  )

export const requireSummaries = (sql: SqlClient.SqlClient, chatId: string) =>
  Effect.flatMap(chatAllows(sql, chatId, "allowsSummaries"), (allowed) =>
    allowed ? Effect.void : Effect.fail(new NotFound({ entity: "summarizable chat", id: chatId }))
  )

/**
 * Refuses a pending chat as it would another user's (NotFound): what only a saved chat has, a
 * pin, a branch, the bin, threads, an export, isn't made for one (DESIGN §2.1).
 */
export const refusePending = (sql: SqlClient.SqlClient, chatId: string) =>
  Effect.flatMap(sql<{ status: string }>`SELECT status FROM chats WHERE id = ${chatId}`, ([row]) =>
    row?.status === "pending" ? Effect.fail(new NotFound({ entity: "chat", id: chatId })) : Effect.void
  )

/** `refusePending` for the chat a fork, a message or a message's version is in. */
export const refusePendingOf = (sql: SqlClient.SqlClient, target: "branch" | "slot" | "version", id: string) =>
  Effect.flatMap(
    target === "branch"
      ? sql<{ status: string }>`SELECT c.status FROM forks f JOIN chats c ON c.id = f.chat_id WHERE f.id = ${id}`
      : target === "slot"
        ? sql<{ status: string }>`SELECT c.status FROM slots s JOIN chats c ON c.id = s.chat_id WHERE s.id = ${id}`
        : sql<{ status: string }>`SELECT c.status FROM versions v JOIN slots s ON s.id = v.slot_id
            JOIN chats c ON c.id = s.chat_id WHERE v.id = ${id}`,
    ([row]) => (row?.status === "pending" ? Effect.fail(new NotFound({ entity: target, id })) : Effect.void)
  )
