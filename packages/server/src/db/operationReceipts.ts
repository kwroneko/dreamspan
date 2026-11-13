// A write commits before its RPC handler can shape the model's result. Preserve that
// crash interval explicitly, then replace the pending result exactly once before delivery.
import type { SqlClient } from "effect/sql"
import { Effect, Schema } from "effect"

const Pending = Schema.Struct({
  operationReceipt: Schema.Literal("pending"),
  operation: Schema.String,
  value: Schema.Unknown
})
export const pendingOperationResult = (operation: string, value: unknown) =>
  JSON.stringify({ operationReceipt: "pending", operation, value })
export const pendingOperationReceipt = (text: string): typeof Pending.Type | null => {
  try {
    const value: unknown = JSON.parse(text)
    return Schema.is(Pending)(value) ? value : null
  } catch {
    return null
  }
}
export const unwrapOperationResult = (text: string): unknown => {
  const pending = pendingOperationReceipt(text)
  return pending ? pending.value : (JSON.parse(text) as unknown)
}
export const recoveredOperationText = (text: string) => {
  const pending = pendingOperationReceipt(text)
  return pending
    ? `This change already committed before its result was saved. Do not repeat it. Saved result: ${JSON.stringify(pending.value)}`
    : text
}

/** Called inside the serial writer transaction; provider call ids never order effects. */
export const nextReceiptTime = (sql: SqlClient.SqlClient, rolloutId: string) =>
  Effect.map(
    sql<{
      at: number
    }>`SELECT coalesce(max(created_at), 0) AS at FROM rollout_receipts WHERE rollout_id = ${rolloutId}`,
    ([previous]) => Math.max(Date.now(), previous!.at + 1)
  )
