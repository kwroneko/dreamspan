import { inFork, viewAt, writeOverride } from "./forkState.ts"
// The summary UI's one write of its own (ARCHITECTURE §16): asking for a summary, or a job that
// gave up, to be done again with the next reply. A request is a row the planner finds.
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { ownedModel } from "./generationSettings.ts"
import { NotFound, type WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

export const makeLcmUiWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    SetSummaryRerun: ({ userId, chatId, forkId, target, requested, model }) =>
      Effect.gen(function* () {
        const [chat] =
          yield* sql`SELECT 1 FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        if (model && !(yield* ownedModel(sql, userId, model.connection, model.model)))
          return yield* new NotFound({ entity: "model", id: model.model })
        const summaryId = target._tag === "Summary" ? target.summaryId : null
        const jobId = target._tag === "Job" ? target.jobId : null
        const [row] = summaryId
          ? yield* sql<{
              first_slot_id: string
            }>`SELECT first_slot_id FROM summaries WHERE id=${summaryId} AND chat_id=${chatId} AND sealed=1`
          : yield* sql<{
              first_slot_id: string
            }>`SELECT first_slot_id FROM summarization_jobs WHERE id=${jobId} AND chat_id=${chatId}`
        if (!row) return yield* new NotFound({ entity: "summary target", id: summaryId ?? jobId! })
        const id = requested ? uuidv7() : null
        if (requested)
          yield* sql`INSERT INTO summary_reruns(id,chat_id,summary_id,job_id,requested_at,model_json)
          VALUES (${id},${chatId},${summaryId},${jobId},${Date.now()},${model ? JSON.stringify(model) : null})`
        yield* writeOverride(
          sql,
          { id: (yield* viewAt(sql, chatId, null))!, chatId },
          {
            kind: "summary_rerun",
            targetId: summaryId ?? jobId!,
            slotId: row.first_slot_id,
            valueId: id,
            flag: requested ? 1 : 0
          }
        )
      }).pipe(inFork(sql, chatId, forkId, null), transaction(sql, "SetSummaryRerun"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
