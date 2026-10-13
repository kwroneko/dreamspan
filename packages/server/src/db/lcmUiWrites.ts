// The summary UI's one write of its own (ARCHITECTURE §16): asking for a summary, or a job that
// gave up, to be done again with the next reply. A request is a row the planner finds.
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

export const makeLcmUiWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    SetSummaryRerun: ({ userId, chatId, target, requested }) =>
      Effect.gen(function* () {
        const [chat] =
          yield* sql`SELECT 1 FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        if (target._tag === "Summary") {
          const [row] = yield* sql`SELECT 1 FROM summaries WHERE id = ${target.summaryId} AND chat_id = ${chatId}`
          if (!row) return yield* new NotFound({ entity: "summary", id: target.summaryId })
          yield* requested
            ? sql`INSERT INTO summary_reruns (id, chat_id, summary_id, requested_at)
                VALUES (${uuidv7()}, ${chatId}, ${target.summaryId}, ${Date.now()}) ON CONFLICT DO NOTHING`
            : sql`DELETE FROM summary_reruns WHERE summary_id = ${target.summaryId}`
        } else {
          const [row] = yield* sql`SELECT 1 FROM summarization_jobs WHERE id = ${target.jobId} AND chat_id = ${chatId}`
          if (!row) return yield* new NotFound({ entity: "summary job", id: target.jobId })
          yield* requested
            ? sql`INSERT INTO summary_reruns (id, chat_id, job_id, requested_at)
                VALUES (${uuidv7()}, ${chatId}, ${target.jobId}, ${Date.now()}) ON CONFLICT DO NOTHING`
            : sql`DELETE FROM summary_reruns WHERE job_id = ${target.jobId}`
        }
      }).pipe(transaction(sql, "SetSummaryRerun"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
