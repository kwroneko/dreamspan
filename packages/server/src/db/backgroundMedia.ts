import { ChatBackgroundEntry } from "@dreamspan/shared/chatBackgrounds.ts"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"

export const BACKGROUNDS_KEY = "chat_backgrounds"
export const MAX_BACKGROUNDS = 100
export const BackgroundHolds = Schema.Array(
  Schema.Struct({ ...ChatBackgroundEntry.fields, galleryOnly: Schema.Boolean })
).check(Schema.isMaxLength(MAX_BACKGROUNDS))

const decode = Schema.decodeUnknownSync(BackgroundHolds)

export const readBackgroundHolds = (sql: SqlClient.SqlClient, userId: string) =>
  sql<{ value_json: string }>`SELECT value_json FROM settings
    WHERE scope = 'user' AND scope_id = ${userId} AND key = ${BACKGROUNDS_KEY}`.pipe(
    Effect.map(([row]) => (row ? decode(JSON.parse(row.value_json)) : []))
  )

/** A gallery-only reference holds the bytes without granting use as a card, cover or message. */
export const backgroundHeldBy = (sql: SqlClient.SqlClient, column: string, userId: string, galleryOnly = false) =>
  sql`EXISTS (SELECT 1 FROM settings s JOIN json_each(s.value_json) b
    WHERE s.scope = 'user' AND s.scope_id = ${userId} AND s.key = ${BACKGROUNDS_KEY}
      AND b.value ->> 'mediaId' = ${sql.literal(column)}
      ${galleryOnly ? sql`AND b.value ->> 'galleryOnly' = 1` : sql``})`
