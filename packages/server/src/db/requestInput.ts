import type { SqlClient } from "effect/sql"

/** The raw prompt total is already retained in the ledger, including on older requests. */
export const recordedPromptTotalSql = (prefix: "" | "q." | "r." = "") => {
  const read = `${prefix}cache_read`
  const write = `${prefix}cache_write`
  const prompt = `json_extract(${prefix}raw_usage_json, '$.prompt_tokens')`
  return `CASE WHEN ${read} > 0 AND ${write} > 0
    AND typeof(${prompt}) = 'integer' AND ${prompt} <= ${Number.MAX_SAFE_INTEGER}
    AND ${prompt} >= max(${read}, ${write}) AND ${prompt} < ${read} + ${write} THEN ${prompt} END`
}

export const recordedPromptTotal = (sql: SqlClient.SqlClient, prefix?: "q." | "r.") =>
  sql.literal(recordedPromptTotalSql(prefix))

export const requestInputTokens = (sql: SqlClient.SqlClient) =>
  sql`coalesce(${recordedPromptTotal(sql)}, coalesce(input_uncached, 0) + coalesce(cache_read, 0) + coalesce(cache_write, 0))`
