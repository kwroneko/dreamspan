// Read-only, bounded ledger calibration. Owner, connection, model and tokenizer stay apart;
// estimated usage, images/tools and failed requests never train the correction.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { UserId } from "@rp/shared/domain.ts"

export const readTextCalibration = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  connectionId: string,
  modelKey: string,
  tokenizer: string,
  asOf = Number.MAX_SAFE_INTEGER
) =>
  Effect.map(
    sql<{ estimated: number | null; actual: number | null; samples: number }>`
    SELECT SUM(estimated_input) AS estimated, SUM(input_uncached + COALESCE(cache_read,0) + COALESCE(cache_write,0)) AS actual, COUNT(*) AS samples
    FROM (SELECT estimated_input, input_uncached, cache_read, cache_write FROM llm_requests
      WHERE owner_user_id=${userId} AND connection_id=${connectionId} AND model_key=${modelKey}
        AND input_tokenizer=${tokenizer} AND status='complete' AND usage_source='reported' AND ended_at <= ${asOf}
        AND estimated_input > 0 AND input_uncached IS NOT NULL
      ORDER BY started_at DESC, id DESC LIMIT 32)`,
    ([row]) =>
      row?.estimated && row.actual && row.samples
        ? { ratio: Math.max(0.25, Math.min(4, row.actual / row.estimated)), samples: row.samples }
        : null
  )
