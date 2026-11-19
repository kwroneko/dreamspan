import { chatKinds } from "@dreamspan/shared/chatKinds.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { NotFound } from "@dreamspan/shared/errors.ts"

/** Callers establish ownership before using this internal policy lookup. Unknown kinds fail closed. */
export const chatAllows = (sql: SqlClient.SqlClient, chatId: string, feature: "allowsSummaries" | "allowsMerge") =>
  Effect.map(
    sql<{ kind: string }>`SELECT kind FROM chats WHERE id = ${chatId}`,
    ([row]) => row !== undefined && chatKinds.get(row.kind)?.[feature] === true
  )

export const requireSummaries = (sql: SqlClient.SqlClient, chatId: string) =>
  Effect.flatMap(chatAllows(sql, chatId, "allowsSummaries"), (allowed) =>
    allowed ? Effect.void : Effect.fail(new NotFound({ entity: "summarizable chat", id: chatId }))
  )
