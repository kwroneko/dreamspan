import type { SqlClient } from "effect/sql"
import { Effect } from "effect"

/** The Files quota counts each held media row once per account. */
export const filesQuotaMediaIds = (sql: SqlClient.SqlClient, userId: string) =>
  sql`SELECT media_id FROM file_versions WHERE owner_user_id = ${userId} AND media_id IS NOT NULL
    UNION
    SELECT media_id FROM media_refs WHERE owner_user_id = ${userId} AND files_quota = 1
    UNION
    SELECT i.media_id FROM drafts d JOIN composer_images i ON i.draft_id = d.id
      WHERE d.user_id = ${userId} AND i.staged = 1 AND i.status = 'active'
    UNION
    SELECT media_id FROM swept_composer_files WHERE user_id = ${userId}`

/** Additional bytes when a workshop gives media a durable Files quota reference. */
export const workshopMediaCharge = (
  sql: SqlClient.SqlClient,
  userId: string,
  media: ReadonlyArray<{ readonly sha256: string; readonly byteSize: number }>
) =>
  sql<{ bytes: number }>`WITH requested AS (
    SELECT value ->> 'sha256' AS sha256, max(value ->> 'byteSize') AS byte_size
    FROM json_each(${JSON.stringify(media)}) GROUP BY sha256
  ), held AS (${filesQuotaMediaIds(sql, userId)})
  SELECT coalesce(sum(coalesce(m.byte_size, i.byte_size)), 0) AS bytes
  FROM requested i LEFT JOIN media_assets m ON m.sha256 = i.sha256
  LEFT JOIN held ON held.media_id = m.id
  WHERE held.media_id IS NULL`.pipe(Effect.map(([row]) => row!.bytes))

export const markWorkshopMediaCharged = (sql: SqlClient.SqlClient, userId: string, hashes: ReadonlyArray<string>) =>
  hashes.length === 0
    ? Effect.void
    : sql`UPDATE media_refs SET files_quota = 1 WHERE owner_user_id = ${userId}
        AND media_id IN (SELECT id FROM media_assets WHERE sha256 IN ${sql.in(hashes)})`.pipe(Effect.asVoid)
