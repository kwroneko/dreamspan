import { putUserSetting } from "./settings.ts"
// Decision models' storage (spec/AGENTIC.md §7). The settings are `settings` key `decisions`,
// `{ connections: { [id]: { model, points: { [point]: { on, threshold } } } } }`; only entries
// whose connection (and model) are still the user's and live read back, so a deleted connection
// sends nothing. Each decision call is a rollout of kind `decision`: its state and questions are
// its snapshot, its answers and verdict its transcript, and its ledger rows roll up onto it, so
// the Activity panel lists it with tokens and cost. The presence point's state events attach to
// the reply's version with the decision rollout as their origin, so a swipe takes them back.
import type { ConnectionDecisions } from "@dreamspan/shared/decisions.ts"
import type { ChatId, SlotId } from "@dreamspan/shared/chat.ts"
import type { FoldableEvent } from "@dreamspan/shared/state.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { ConnectionId, ModelId } from "@dreamspan/shared/providers.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { Bin } from "./bin.ts"
import { ownedModel } from "./generationSettings.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { correctPresence } from "./presenceCorrection.ts"
import { selectionIn } from "./forkState.ts"
import { stateEventsThrough } from "./stateRead.ts"
import { withoutPurged } from "./stateRefs.ts"
import { decisionStateStamp, decisionWindowStamp, PRESENCE_WINDOW_SIZE } from "../decision/stateStamp.ts"
import { NotFound, type ReadOps, type WriteOps } from "./ops.ts"
import { query, transaction } from "./tx.ts"
import { brokenTurnAt } from "./autoGuard.ts"
import { readPathTail } from "./reads.ts"

const KEY = "decisions"

const stored = (sql: SqlClient.SqlClient, userId: UserId) =>
  sql<{
    value_json: string
  }>`SELECT value_json FROM settings WHERE scope = 'user' AND scope_id = ${userId} AND key = ${KEY}`.pipe(
    Effect.map(([row]): Array<ConnectionDecisions> => {
      if (!row) return []
      const value = JSON.parse(row.value_json) as { connections?: unknown }
      const connections = value.connections
      if (!connections || typeof connections !== "object" || Array.isArray(connections)) return []
      return Object.entries(connections as Record<string, { model?: unknown; points?: unknown }>).flatMap(
        ([connectionId, entry]) => {
          if (!entry || typeof entry !== "object") return []
          const points: Record<string, { on: boolean; threshold: number }> = {}
          for (const [id, p] of Object.entries((entry.points ?? {}) as Record<string, unknown>)) {
            const point = p as { on?: unknown; threshold?: unknown }
            if (typeof point?.on === "boolean" && typeof point.threshold === "number")
              points[id] = { on: point.on, threshold: point.threshold }
          }
          return [
            {
              connectionId: connectionId as ConnectionId,
              model: typeof entry.model === "string" ? (entry.model as ModelId) : null,
              points
            }
          ]
        }
      )
    })
  )

/** The entries whose connection is still the user's and live; a model that isn't its connection's reads as none. */
const live = (sql: SqlClient.SqlClient, userId: UserId) =>
  Effect.gen(function* () {
    const entries = yield* stored(sql, userId)
    if (entries.length === 0) return entries
    const rows = yield* sql<{ id: string }>`SELECT id FROM connections WHERE owner_user_id = ${userId}
      AND deleted_at IS NULL AND purged_at IS NULL AND id IN ${sql.in(entries.map((e) => e.connectionId))}`
    const kept = new Set(rows.map((row) => row.id))
    const out: Array<ConnectionDecisions> = []
    for (const entry of entries) {
      if (!kept.has(entry.connectionId)) continue
      const model =
        entry.model !== null && (yield* ownedModel(sql, userId, entry.connectionId, entry.model)) ? entry.model : null
      out.push({ ...entry, model })
    }
    return out
  })

export const makeDecisionReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    GetDecisionSettings: ({ userId }) => live(sql, userId).pipe(query("GetDecisionSettings"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})

export const makeDecisionWriteHandlers = (bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const graph = makeGraphWrites(sql, bin.drafts)
    /** A decision rollout of the user's, with what its effects attach to. */
    const decisionRollout = (userId: UserId, rolloutId: string) =>
      sql<{
        readonly chat_id: string
        readonly status: string
        readonly slot_id: string | null
        readonly fork_id: string | null
      }>`
        SELECT r.chat_id, r.status, r.slot_id, r.fork_id FROM rollouts r JOIN chats c ON c.id = r.chat_id
        WHERE r.id = ${rolloutId} AND r.kind = 'decision' AND c.owner_user_id = ${userId}`.pipe(
        Effect.flatMap(([row]) =>
          row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "decision", id: rolloutId }))
        )
      )
    return {
      SetDecisionSettings: ({ userId, connectionId, model, points }) =>
        Effect.gen(function* () {
          const [connection] = yield* sql<{ id: string }>`SELECT id FROM connections WHERE id = ${connectionId}
            AND owner_user_id = ${userId} AND deleted_at IS NULL AND purged_at IS NULL`
          if (!connection) return yield* new NotFound({ entity: "connection", id: connectionId })
          if (model !== null && !(yield* ownedModel(sql, userId, connectionId, model)))
            return yield* new NotFound({ entity: "model", id: model })
          const next = (yield* live(sql, userId)).filter((entry) => entry.connectionId !== connectionId)
          next.push({ connectionId, model, points })
          const value = {
            connections: Object.fromEntries(
              next.map((entry) => [entry.connectionId, { model: entry.model, points: entry.points }])
            )
          }
          yield* putUserSetting(sql, userId, KEY, value)
          return next
        }).pipe(transaction(sql, "SetDecisionSettings")),

      StartDecisionRollout: ({
        userId,
        chatId,
        rolloutId,
        slotId,
        forkId,
        connectionId,
        modelId,
        requestClass,
        snapshot
      }) =>
        Effect.gen(function* () {
          const [chat] = yield* sql<{ id: string }>`SELECT id FROM chats
            WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
          if (!chat || !(yield* ownedModel(sql, userId, connectionId, modelId)))
            return yield* new NotFound({ entity: "decision", id: rolloutId })
          // Asked for an Auto turn that may no longer send anything (db/autoGuard.ts).
          if (slotId !== null && (yield* brokenTurnAt(sql, slotId)))
            return yield* new NotFound({ entity: "decision", id: rolloutId })
          if (slotId !== null) {
            const [slot] = yield* sql<{ id: string }>`SELECT id FROM slots WHERE id = ${slotId} AND chat_id = ${chatId}`
            if (!slot) return yield* new NotFound({ entity: "slot", id: slotId })
          }
          const now = Date.now()
          yield* sql`INSERT INTO rollouts ${sql.insert({
            id: rolloutId,
            chat_id: chatId,
            fork_id: forkId,
            kind: "decision",
            status: "running",
            slot_id: slotId,
            role: "decision",
            connection_id: connectionId,
            model_id: modelId,
            request_class: requestClass,
            created_at: now,
            started_at: now,
            updated_at: now
          })}`
          yield* sql`INSERT INTO rollout_payloads ${sql.insert({ rollout_id: rolloutId, context_snapshot_json: snapshot })}`
        }).pipe(transaction(sql, "StartDecisionRollout")),

      FinishDecisionRollout: ({ userId, rolloutId, status, error, result }) =>
        Effect.gen(function* () {
          yield* decisionRollout(userId, rolloutId)
          const [usage] = yield* sql<{
            requests: number
            input: number | null
            output: number | null
            cache_read: number | null
            cache_write: number | null
            cost: number | null
          }>`
            SELECT count(*) AS requests, sum(input_uncached) AS input, sum(output) AS output,
              sum(cache_read) AS cache_read, sum(cache_write) AS cache_write, sum(cost) AS cost
            FROM llm_requests WHERE rollout_id = ${rolloutId}`
          const now = Date.now()
          yield* sql`UPDATE rollouts SET status = ${status}, error = ${error}, llm_requests = ${usage!.requests},
            usage_input_tokens = ${usage!.input}, usage_output_tokens = ${usage!.output},
            usage_cache_read_tokens = ${usage!.cache_read}, usage_cache_write_tokens = ${usage!.cache_write},
            usage_cost = ${usage!.cost}, completed_at = ${now}, updated_at = ${now}
            WHERE id = ${rolloutId} AND status = 'running'`
          yield* sql`UPDATE rollout_payloads SET transcript_json = ${result} WHERE rollout_id = ${rolloutId}`
        }).pipe(transaction(sql, "FinishDecisionRollout")),

      PickSpeaker: ({ userId, rolloutId, versionId, speakerEntityId, name, confidence }) =>
        Effect.gen(function* () {
          const decision = yield* decisionRollout(userId, rolloutId)
          const [version] = yield* sql<{
            readonly slot_id: string
            readonly status: string
            readonly content_length: number
            readonly speaker_pick_json: string | null
          }>`
            SELECT v.slot_id, v.status, v.content_length, v.speaker_pick_json FROM versions v JOIN slots s ON s.id = v.slot_id
            WHERE v.id = ${versionId} AND s.chat_id = ${decision.chat_id} AND v.deleted_at IS NULL`
          if (!version || version.slot_id !== decision.slot_id)
            return yield* new NotFound({ entity: "decision version", id: versionId })
          // Only a reply Auto picked for, before its first word: a later choice or text stays.
          const auto = version.speaker_pick_json !== null && JSON.parse(version.speaker_pick_json).by === "auto"
          if (
            decision.status !== "completed" ||
            version.status !== "generating" ||
            version.content_length !== 0 ||
            !auto
          )
            return false
          yield* graph.checkSpeaker(userId, speakerEntityId)
          yield* sql`UPDATE versions SET speaker_entity_id = ${speakerEntityId},
            speaker_pick_json = ${JSON.stringify({ by: "decision", confidence, name, rolloutId })},
            updated_at = ${Date.now()} WHERE id = ${versionId}`
          return true
        }).pipe(transaction(sql, "PickSpeaker")),

      SettleSpeaker: ({ userId, versionId, speakerEntityId }) =>
        Effect.gen(function* () {
          if (speakerEntityId !== undefined) yield* graph.checkSpeaker(userId, speakerEntityId)
          const settled = yield* sql<{ readonly id: string }>`
            UPDATE versions SET speaker_entity_id = coalesce(${speakerEntityId ?? null}, speaker_entity_id),
              speaker_pick_json = ${JSON.stringify({ by: "order" })}, updated_at = ${Date.now()}
            WHERE id = ${versionId} AND json_extract(speaker_pick_json, '$.by') = 'auto'
              AND status = 'generating' AND content_length = 0 AND deleted_at IS NULL
              AND slot_id IN (SELECT s.id FROM slots s JOIN chats c ON c.id = s.chat_id WHERE c.owner_user_id = ${userId})
            RETURNING id`
          return settled.length > 0
        }).pipe(transaction(sql, "SettleSpeaker")),

      ApplyDecisionEffect: ({ userId, rolloutId, versionId, expectedState, expectedWindow, events }) =>
        Effect.gen(function* () {
          const decision = yield* decisionRollout(userId, rolloutId)
          const [version] = yield* sql<{ readonly slot_id: string; readonly fork_id: string | null }>`
            SELECT v.slot_id, g.fork_id FROM versions v JOIN slots s ON s.id = v.slot_id
            LEFT JOIN rollouts g ON g.id = v.rollout_id
            WHERE v.id = ${versionId} AND s.chat_id = ${decision.chat_id} AND v.deleted_at IS NULL`
          if (!version) return yield* new NotFound({ entity: "version", id: versionId })
          if (version.slot_id !== decision.slot_id)
            return yield* new NotFound({ entity: "decision version", id: versionId })
          const fork = decision.fork_id ?? version.fork_id
          // Recheck in the write transaction: provider latency must not overwrite a newer choice.
          if (
            decision.status !== "completed" ||
            (yield* selectionIn(sql, fork, version.slot_id))?.shown_id !== versionId
          )
            return false
          const rows = yield* stateEventsThrough(sql, decision.chat_id as ChatId, version.slot_id as SlotId, fork)
          const current = yield* withoutPurged(
            sql,
            rows.map((row) => ({
              scope: row.scope,
              data: { key: row.key, value: JSON.parse(row.value_json) }
            })) as Array<FoldableEvent>
          )
          if (decisionStateStamp(current) !== expectedState) return false
          const [view] = yield* sql<{ id: string }>`SELECT f.id FROM forks f JOIN chats c ON c.id = f.chat_id
            WHERE c.id = ${decision.chat_id} AND c.deleted_at IS NULL
              AND f.id = coalesce(${fork}, c.current_fork_id) AND f.deleted_at IS NULL`
          if (!view) return false
          const window = yield* readPathTail(
            sql,
            decision.chat_id as ChatId,
            view.id,
            version.slot_id as SlotId,
            PRESENCE_WINDOW_SIZE
          )
          if (decisionWindowStamp(window) !== expectedWindow) return false
          for (const data of events)
            yield* graph.insertStateEvent(userId, decision.chat_id, version.slot_id, versionId, null, data, fork, {
              origin: "rollout",
              ref: rolloutId
            })
          return events.length > 0
        }).pipe(transaction(sql, "ApplyDecisionEffect")),

      CorrectPresence: (payload) => correctPresence(sql, graph)(payload).pipe(transaction(sql, "CorrectPresence"))
    } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
  })
