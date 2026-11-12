// Consent is read and checked only in workers. A write merges one choice in one transaction.
import { DEFAULT_EXTERNAL_MEDIA, ExternalMediaPrefs, externalMediaAllowed } from "@rp/shared/externalMedia.ts"
import type { ExternalMediaTarget } from "@rp/shared/externalMedia.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { NotFound } from "@rp/shared/errors.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { ReadOps, WriteOps } from "./ops.ts"
import { putUserSetting, readSetting } from "./settings.ts"
import { query, transaction } from "./tx.ts"

const KEY = "media.external"
const read = (sql: SqlClient.SqlClient, userId: UserId) =>
  readSetting(sql, "user", userId, KEY).pipe(
    Effect.map(({ value }) =>
      Schema.decodeUnknownOption(ExternalMediaPrefs)(value).pipe((decoded) =>
        decoded._tag === "Some" ? decoded.value : DEFAULT_EXTERNAL_MEDIA
      )
    )
  )

const owned = (sql: SqlClient.SqlClient, userId: UserId, target: ExternalMediaTarget) =>
  Effect.gen(function* () {
    if (target._tag === "Default") return
    const rows =
      target._tag === "Chat"
        ? yield* sql`SELECT id FROM chats WHERE id = ${target.id} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        : yield* sql`SELECT id FROM entities WHERE id = ${target.id} AND owner_user_id = ${userId} AND kind = 'card' AND deleted_at IS NULL`
    if (rows.length === 0)
      return yield* new NotFound({ entity: target._tag === "Chat" ? "chat" : "card", id: target.id })
  })

export const makeExternalMediaReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    GetExternalMediaPrefs: ({ userId }) => read(sql, userId).pipe(query("GetExternalMediaPrefs")),
    CheckExternalMedia: ({ userId, chatId, cardId }) =>
      Effect.gen(function* () {
        if (chatId === null && cardId === null) return false
        if (chatId !== null) yield* owned(sql, userId, { _tag: "Chat", id: chatId })
        if (cardId !== null) yield* owned(sql, userId, { _tag: "Card", id: cardId })
        return externalMediaAllowed(yield* read(sql, userId), chatId, cardId)
      }).pipe(query("CheckExternalMedia"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})

export const makeExternalMediaWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    SetExternalMedia: ({ userId, target, allow }) =>
      Effect.gen(function* () {
        yield* owned(sql, userId, target)
        const stored = yield* read(sql, userId)
        let next: ExternalMediaPrefs
        if (target._tag === "Default") next = { ...stored, default: allow ?? false }
        else {
          const key = target._tag === "Card" ? "cards" : "chats"
          const choices = { ...stored[key] }
          if (allow === null) delete choices[target.id]
          else choices[target.id] = allow
          next = { ...stored, [key]: choices }
        }
        yield* putUserSetting(sql, userId, KEY, next)
        return next
      }).pipe(transaction(sql, "SetExternalMedia"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
