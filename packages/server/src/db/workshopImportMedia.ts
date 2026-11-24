import type { SqlClient } from "effect/sql"

/** Media that this import will give the account a durable library reference to for the first time. */
export const newWorkshopImportMedia = (
  sql: SqlClient.SqlClient,
  userId: string,
  media: ReadonlyArray<{ readonly sha256: string; readonly byteSize: number }>
) =>
  sql<{ sha256: string; addedBytes: number }>`WITH requested AS (
    SELECT value ->> 'sha256' AS sha256, max(value ->> 'byteSize') AS byte_size
    FROM json_each(${JSON.stringify(media)}) GROUP BY sha256
  )
  SELECT i.sha256, CASE WHEN EXISTS (
    SELECT 1 FROM file_versions v WHERE v.owner_user_id = ${userId} AND v.media_id = m.id
  ) THEN 0 ELSE coalesce(m.byte_size, i.byte_size) END AS addedBytes
  FROM requested i LEFT JOIN media_assets m ON m.sha256 = i.sha256
  WHERE NOT EXISTS (SELECT 1 FROM media_refs r WHERE r.owner_user_id = ${userId} AND r.media_id = m.id)`
