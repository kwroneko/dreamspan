// Agent rollouts' reads (spec/AGENTIC.md §5): a version's steps, projected from its stored
// transcript with the tools its snapshot froze, as the live display projects the running one.
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { stepsOf } from "../agent/steps.ts"
import type { FrozenTool } from "../agent/tools.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import { query } from "./tx.ts"

export const makeAgentReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    RolloutSteps: ({ userId, versionId }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{
          readonly transcript: string | null
          readonly tools: string | null
          readonly running: number
        }>`
          SELECT p.transcript_json AS transcript, json_extract(p.context_snapshot_json, '$.agent.tools') AS tools,
            r.status IN ('pending', 'running') AS running
          FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
          JOIN rollouts r ON r.id = v.rollout_id LEFT JOIN rollout_payloads p ON p.rollout_id = r.id
          WHERE v.id = ${versionId} AND c.owner_user_id = ${userId}
            AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL`
        if (!row) return yield* new NotFound({ entity: "version", id: versionId })
        if (!row.transcript) return []
        const tools = row.tools ? (JSON.parse(row.tools) as ReadonlyArray<FrozenTool>) : []
        return stepsOf(JSON.parse(row.transcript) as ReadonlyArray<AgentMessage>, tools, row.running === 0)
      }).pipe(query("RolloutSteps"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
