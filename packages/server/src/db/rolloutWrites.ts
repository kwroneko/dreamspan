// A rollout's chat-state effects (spec/AGENTIC.md §4.3): a tool call's state events, attached
// to the version being generated so they hold only while it's shown (a swipe reverses them),
// written with the call's receipt in one transaction. A call already receipted writes nothing
// again and answers with what it answered the first time: a resume re-runs it harmlessly.
import { NotFound } from "@rp/shared/errors.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { Bin } from "./bin.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import type { WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

type Handlers = Parameters<typeof WriteOps.of>[0]

export const makeRolloutWriteHandlers = (bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const graph = makeGraphWrites(sql, bin.drafts)
    return {
      ApplyRolloutEffect: ({ userId, rolloutId, toolCallId, events, result }) =>
        Effect.gen(function* () {
          const [rollout] = yield* sql<{
            readonly chat_id: string
            readonly fork_id: string | null
            readonly version_id: string
            readonly slot_id: string
            readonly status: string
          }>`
            SELECT r.chat_id, r.fork_id, v.id AS version_id, v.slot_id, r.status
            FROM rollouts r JOIN chats c ON c.id = r.chat_id JOIN versions v ON v.rollout_id = r.id
            WHERE r.id = ${rolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND v.deleted_at IS NULL`
          if (!rollout) return yield* new NotFound({ entity: "rollout", id: rolloutId })
          const [receipt] = yield* sql<{ readonly result_json: string }>`
            SELECT result_json FROM rollout_receipts WHERE rollout_id = ${rolloutId} AND tool_call_id = ${toolCallId}`
          if (receipt) return { result: JSON.parse(receipt.result_json) as string, replayed: true }
          if (rollout.status !== "running" && rollout.status !== "created")
            return yield* new NotFound({ entity: "running rollout", id: rolloutId })
          for (const data of events) {
            yield* graph.insertStateEvent(
              userId,
              rollout.chat_id,
              rollout.slot_id,
              rollout.version_id,
              null,
              data,
              rollout.fork_id,
              { origin: "rollout", ref: rolloutId }
            )
          }
          yield* sql`INSERT INTO rollout_receipts ${sql.insert({
            rollout_id: rolloutId,
            tool_call_id: toolCallId,
            result_json: JSON.stringify(result),
            created_at: Date.now()
          })}`
          return { result, replayed: false }
        }).pipe(transaction(sql, "ApplyRolloutEffect"))
    } satisfies Partial<Handlers>
  })
