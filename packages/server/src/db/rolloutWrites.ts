// A resumed agent reply's writes (spec/AGENTIC.md §4.2): the new version and its rollout, with
// the stopped one's effects for the calls kept. The effects themselves: rolloutEffects.ts.
import { NotResumable } from "@rp/shared/agent.ts"
import type { ChatId, ForkId, Version } from "@rp/shared/chat.ts"
import { NotFound, type StaleWrite } from "@rp/shared/errors.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import type { Bin } from "./bin.ts"
import { effectRef } from "./rolloutEffects.ts"
import { nextSeq } from "./forkState.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import type { StorageError, WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

type Handlers = Parameters<typeof WriteOps.of>[0]


/** The version write a resume makes first (writes.ts), in the same transaction. */
type AddSelectedVersion = (
  payload: Parameters<Handlers["AddSelectedVersion"]>[0]
) => Effect.Effect<
  { readonly chatId: ChatId; readonly forkId: ForkId; readonly version: Version },
  NotFound | StaleWrite | StorageError | SqlError.SqlError
>

export const makeRolloutWriteHandlers = (bin: Bin, addSelectedVersion: AddSelectedVersion) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const graph = makeGraphWrites(sql, bin.drafts)
    return {
      StartResumedVersion: ({
        userId,
        versionId,
        forkId,
        expectedRowVersion,
        rolloutId,
        version,
        transcript,
        steps,
        keptCalls,
        branch
      }) =>
        Effect.gen(function* () {
          const [source] = yield* sql<{
            readonly rollout_id: string
            readonly slot_id: string
            readonly status: string
            readonly connection_id: string | null
            readonly model_id: string | null
          }>`
            SELECT r.id AS rollout_id, v.slot_id, v.status, r.connection_id, r.model_id
            FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
            JOIN rollouts r ON r.id = v.rollout_id
            WHERE v.id = ${versionId} AND c.owner_user_id = ${userId} AND r.kind = 'generation'
              AND r.mode IS NOT NULL AND v.deleted_at IS NULL AND c.deleted_at IS NULL`
          if (!source) return yield* new NotFound({ entity: "agent reply", id: versionId })
          if (source.status === "generating")
            return yield* new NotResumable({ versionId, message: "It's still being written." })
          const [resuming] = yield* sql`
            SELECT 1 FROM versions WHERE source_version_id = ${versionId} AND origin = 'resumed'
              AND status = 'generating' AND deleted_at IS NULL`
          if (resuming) return yield* new NotResumable({ versionId, message: "It's already being resumed." })
          const added = yield* addSelectedVersion({
            userId,
            slotId: source.slot_id as never,
            forkId: forkId ?? null,
            version,
            expectedRowVersion,
            ...(source.connection_id && source.model_id
              ? { model: { connection: source.connection_id as never, model: source.model_id as never } }
              : {})
          })
          const now = Date.now()
          // The same run, carried on: its model, mode, cast and frozen context are the source's.
          yield* sql`INSERT INTO rollouts (id, chat_id, kind, status, slot_id, leaf_slot_id, parent_rollout_id,
              role, connection_id, model_id, request_class, context_issues_json, history_start_slot_id,
              history_start_depth, history_depth, fork_id, step_count, mode, created_at, started_at, updated_at)
            SELECT ${rolloutId}, chat_id, kind, 'running', slot_id, leaf_slot_id, id, role, connection_id, model_id,
              request_class, context_issues_json, history_start_slot_id, history_start_depth, history_depth,
              ${added.forkId}, ${steps}, mode, ${now}, ${now}, ${now}
            FROM rollouts WHERE id = ${source.rollout_id}`
          yield* sql`INSERT INTO rollout_payloads (rollout_id, context_snapshot_json, transcript_json)
            SELECT ${rolloutId}, context_snapshot_json, ${transcript}
            FROM rollout_payloads WHERE rollout_id = ${source.rollout_id}`
          yield* sql`INSERT INTO lore_activations (rollout_id, entries_json, message_offset)
            SELECT ${rolloutId}, entries_json, message_offset FROM lore_activations WHERE rollout_id = ${source.rollout_id}`
          yield* sql`UPDATE versions SET rollout_id = ${rolloutId},
              cast_json = (SELECT cast_json FROM versions WHERE id = ${versionId}), updated_at = ${now}
            WHERE id = ${added.version.id}`
          // The stopped version's own events (its variables), and the effects of the tool calls
          // kept, so they apply while the new version is shown; the cut calls' stay behind.
          const prefix = `${source.rollout_id}:`
          const kept = new Set(keptCalls.map((id) => effectRef(source.rollout_id, id)))
          const events = yield* sql<{
            readonly key: string
            readonly scope: string | null
            readonly value_json: string
            readonly origin: string
            readonly origin_ref: string | null
            readonly slot_chain_id: string | null
            readonly slot_depth: number | null
          }>`
            SELECT key, scope, value_json, origin, origin_ref, slot_chain_id, slot_depth
            FROM state_events WHERE version_id = ${versionId} ORDER BY seq`
          const copied = events.filter((e) => !e.origin_ref?.startsWith(prefix) || kept.has(e.origin_ref))
          if (copied.length > 0) {
            const [next] = yield* sql<{ n: number }>`
              SELECT coalesce(max(seq), -1) + 1 AS n FROM state_events
              WHERE chat_id = ${added.chatId} AND slot_id = ${source.slot_id}`
            for (const [i, e] of copied.entries()) {
              yield* sql`INSERT INTO state_events ${sql.insert({
                id: uuidv7(),
                chat_id: added.chatId,
                slot_id: source.slot_id,
                version_id: added.version.id,
                seq: next!.n + i,
                fork_id: added.forkId,
                fork_seq: yield* nextSeq(sql, added.chatId),
                key: e.key,
                scope: e.scope,
                value_json: e.value_json,
                origin: e.origin,
                origin_ref: e.origin_ref?.startsWith(prefix)
                  ? `${rolloutId}:${e.origin_ref.slice(prefix.length)}`
                  : e.origin_ref === source.rollout_id
                    ? rolloutId
                    : e.origin_ref,
                slot_chain_id: e.slot_chain_id,
                slot_depth: e.slot_depth,
                created_at: now
              })}`
            }
          }
          for (const id of keptCalls)
            yield* sql`INSERT INTO rollout_receipts (rollout_id, tool_call_id, result_json, created_at)
              SELECT ${rolloutId}, tool_call_id, result_json, ${now} FROM rollout_receipts
              WHERE rollout_id = ${source.rollout_id} AND tool_call_id = ${id}`
          if (branch)
            yield* sql`INSERT INTO rollout_branches ${sql.insert({
              rollout_id: rolloutId,
              branch_no: 1,
              fork_index: (JSON.parse(transcript) as Array<unknown>).length,
              reason: branch.reason,
              messages_json: branch.messages,
              created_at: now
            })}`
          return added
        }).pipe(transaction(sql, "StartResumedVersion"))
    } satisfies Partial<Handlers>
  })
