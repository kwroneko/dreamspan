import { toolData, toolResultFrame } from "../agent/toolData.ts"
// A write commits before its RPC handler can shape the model's result. Preserve that
// crash interval explicitly, then replace the pending result exactly once before delivery.
import type { SqlClient } from "effect/sql"
import { Effect, Schema } from "effect"

const LegacyPending = Schema.Struct({
  operationReceipt: Schema.Literal("pending"),
  operation: Schema.String,
  value: Schema.Unknown
})
const Pending = Schema.Struct({
  ...LegacyPending.fields,
  resultFormat: Schema.Literal("quoted-data-v1")
})
type PendingRead = typeof LegacyPending.Type & { readonly resultFormat?: "quoted-data-v1" }
/** New pending metadata is the receipt JSON root, not a field inside untrusted result text. */
export const pendingOperationResult = (operation: string, value: unknown): typeof Pending.Type => ({
  operationReceipt: "pending",
  operation,
  // Match the old JSON-string receipt's serialization before returning through RPC.
  value: JSON.parse(JSON.stringify(value) ?? "null"),
  resultFormat: "quoted-data-v1"
})
export const pendingOperationReceipt = (input: unknown): PendingRead | null => {
  if (typeof input !== "string") return Schema.is(Pending)(input) ? input : null
  try {
    const value: unknown = JSON.parse(input)
    // Old string receipts keep their old interpretation even if their text imitates a new flag.
    return Schema.is(LegacyPending)(value)
      ? { operationReceipt: value.operationReceipt, operation: value.operation, value: value.value }
      : null
  } catch {
    return null
  }
}
export const unwrapOperationResult = (input: unknown): unknown => {
  const pending = pendingOperationReceipt(input)
  return pending ? pending.value : typeof input === "string" ? (JSON.parse(input) as unknown) : input
}
export const recoveredOperationText = (text: unknown) => {
  const pending = pendingOperationReceipt(text)
  if (!pending) return typeof text === "string" ? text : JSON.stringify(text)
  const notice = "This change already committed before its result was saved. Do not repeat it. Saved result:"
  // Only new pending receipts opt in. Old recovery strings retain their exact bytes.
  return pending.resultFormat === "quoted-data-v1"
    ? `${notice}\n${toolData(JSON.stringify(pending.value), toolResultFrame(pending.value))}`
    : `${notice} ${JSON.stringify(pending.value)}`
}

/** Called inside the serial writer transaction; provider call ids never order effects. */
export const nextReceiptTime = (sql: SqlClient.SqlClient, rolloutId: string) =>
  Effect.map(
    sql<{
      at: number
    }>`SELECT coalesce(max(created_at), 0) AS at FROM rollout_receipts WHERE rollout_id = ${rolloutId}`,
    ([previous]) => Math.max(Date.now(), previous!.at + 1)
  )
