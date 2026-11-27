import { ChatBackgroundEntry } from "@dreamspan/shared/chatBackgrounds.ts"
import { NotFound } from "@dreamspan/shared/errors.ts"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { listed } from "./listedChats.ts"

export const BACKGROUNDS_KEY = "chat_backgrounds"
const LOCAL_PREFIX = "chat_local_backgrounds:"
export const MAX_BACKGROUNDS = 100
export const MAX_LOCAL_BACKGROUNDS = 50
export const MAX_LOCAL_GALLERIES = 500

export const backgroundKey = (chatId?: string) => (chatId === undefined ? BACKGROUNDS_KEY : LOCAL_PREFIX + chatId)
const galleryKeys = (sql: SqlClient.SqlClient) => sql`(s.key = ${BACKGROUNDS_KEY} OR s.key GLOB ${LOCAL_PREFIX + "*"})`

const BackgroundHold = Schema.Struct({ ...ChatBackgroundEntry.fields, galleryOnly: Schema.Boolean })
export const BackgroundHolds = Schema.Array(BackgroundHold).check(Schema.isMaxLength(MAX_BACKGROUNDS))
export const LocalBackgroundHolds = Schema.Array(BackgroundHold).check(Schema.isMaxLength(MAX_LOCAL_BACKGROUNDS))
export const isLocalBackgroundKey = (key: string) => key.startsWith(LOCAL_PREFIX)
const decode = Schema.decodeUnknownSync(BackgroundHolds)

export const readBackgroundHolds = (sql: SqlClient.SqlClient, userId: string, chatId?: string) =>
  sql<{ value_json: string }>`SELECT value_json FROM settings
    WHERE scope = 'user' AND scope_id = ${userId} AND key = ${backgroundKey(chatId)}`.pipe(
    Effect.map(([row]) => (row ? decode(JSON.parse(row.value_json)) : []))
  )

export const countLocalGalleries = (sql: SqlClient.SqlClient, userId: string) =>
  sql<{ count: number }>`SELECT count(*) AS count FROM settings
    WHERE scope = 'user' AND scope_id = ${userId} AND key GLOB ${LOCAL_PREFIX + "*"}`

/** A split chat owns a gallery separately from the original chat or another split. */
export const checkBackgroundChat = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: string,
  chatId: string
) {
  const [owned] = yield* sql`SELECT c.id FROM chats c
    WHERE c.id = ${chatId} AND c.owner_user_id = ${userId} AND ${listed(sql, "c")}
    UNION ALL SELECT f.id FROM forks f JOIN chats c ON c.id = f.chat_id
    WHERE f.id = ${chatId} AND c.owner_user_id = ${userId} AND ${listed(sql, "c")}
      AND f.split_chat = 1 AND f.deleted_at IS NULL AND f.purged_at IS NULL`
  if (!owned) return yield* new NotFound({ entity: "chat", id: chatId })
})

/** A gallery-only reference holds the bytes without granting use as a card, cover or message. */
export const backgroundHeldBy = (sql: SqlClient.SqlClient, column: string, userId: string, galleryOnly = false) =>
  sql`EXISTS (SELECT 1 FROM settings s JOIN json_each(s.value_json) b
    WHERE s.scope = 'user' AND s.scope_id = ${userId} AND ${galleryKeys(sql)}
      AND b.value ->> 'mediaId' = ${sql.literal(column)}
      ${galleryOnly ? sql`AND b.value ->> 'galleryOnly' = 1` : sql``})`

/** Once an ordinary upload claims these bytes, every gallery entry ceases to be their exclusive hold. */
export const promoteBackgroundMedia = (sql: SqlClient.SqlClient, userId: string, mediaId: string) =>
  sql`UPDATE settings AS s SET value_json = (
      SELECT json_group_array(json(CASE WHEN b.value ->> 'mediaId' = ${mediaId}
        THEN json_set(b.value, '$.galleryOnly', json('false')) ELSE b.value END))
      FROM json_each(s.value_json) b
    )
    WHERE s.scope = 'user' AND s.scope_id = ${userId} AND ${galleryKeys(sql)}
      AND EXISTS (SELECT 1 FROM json_each(s.value_json) b
        WHERE b.value ->> 'mediaId' = ${mediaId} AND b.value ->> 'galleryOnly' = 1)`
