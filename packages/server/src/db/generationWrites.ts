// Generation's writes: rollouts and the user's defaults (ARCHITECTURE §15).
import type { UserId } from "@rp/shared/domain.ts"
import { NotFound } from "@rp/shared/errors.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { DEFAULT_MODEL, DEFAULT_PRESET, ownedModel, ownedPreset, readDefaults } from "./generationSettings.ts"
import type { WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

export const makeGenerationWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const ownedRollout = (userId: UserId, rolloutId: string) =>
    sql<{ id: string }>`SELECT r.id FROM rollouts r JOIN chats c ON c.id = r.chat_id
      WHERE r.id = ${rolloutId} AND c.owner_user_id = ${userId}`.pipe(
      Effect.flatMap(([row]) => (row ? Effect.void : Effect.fail(new NotFound({ entity: "rollout", id: rolloutId }))))
    )

  /** `var.set` events of a version, after its slot's others, recorded by a rollout. */
  const setVariables = (
    chatId: string,
    slotId: string,
    versionId: string,
    variables: ReadonlyArray<{ readonly name: string; readonly value: string | number | null }>,
    rolloutId: string,
    now: number
  ) =>
    Effect.gen(function* () {
      if (variables.length === 0) return
      const [next] = yield* sql<{ n: number }>`
        SELECT coalesce(max(seq), -1) + 1 AS n FROM state_events WHERE chat_id = ${chatId} AND slot_id = ${slotId}`
      yield* Effect.forEach(
        variables,
        ({ name, value }, i) =>
          sql`INSERT INTO state_events ${sql.insert({
            id: uuidv7(),
            chat_id: chatId,
            slot_id: slotId,
            version_id: versionId,
            seq: next!.n + i,
            key: "var.set",
            scope: null,
            value_json: JSON.stringify({ name, value }),
            origin: "rollout",
            origin_ref: rolloutId,
            created_at: now
          })}`,
        { discard: true }
      )
    })

  const putSetting = (userId: UserId, key: string, value: unknown) =>
    value === null
      ? sql`DELETE FROM user_settings WHERE user_id = ${userId} AND key = ${key}`
      : sql`INSERT INTO user_settings (user_id, key, value_json) VALUES (${userId}, ${key}, ${JSON.stringify(value)})
          ON CONFLICT (user_id, key) DO UPDATE SET value_json = excluded.value_json`

  const handlers = {
    StartRollout: ({
      userId,
      chatId,
      slotId,
      versionId,
      rolloutId,
      leafSlotId,
      connectionId,
      modelId,
      snapshot,
      issues,
      variables,
      frozenMessages
    }) =>
      Effect.gen(function* () {
        const [version] = yield* sql<{ status: string; writer: string }>`
          SELECT v.status, v.writer FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
          WHERE v.id = ${versionId} AND s.id = ${slotId} AND c.id = ${chatId} AND c.owner_user_id = ${userId}`
        if (!version || version.status !== "generating" || version.writer !== "model") {
          return yield* new NotFound({ entity: "generating version", id: versionId })
        }
        if (!(yield* ownedModel(sql, userId, connectionId, modelId))) {
          return yield* new NotFound({ entity: "model", id: modelId })
        }
        const now = Date.now()
        yield* sql`INSERT INTO rollouts ${sql.insert({
          id: rolloutId,
          chat_id: chatId,
          kind: "generation",
          status: "running",
          slot_id: slotId,
          leaf_slot_id: leafSlotId,
          role: "narrator",
          connection_id: connectionId,
          model_id: modelId,
          request_class: "interactive",
          context_issues_json: JSON.stringify(issues),
          created_at: now,
          started_at: now,
          updated_at: now
        })}`
        yield* sql`INSERT INTO rollout_payloads ${sql.insert({ rollout_id: rolloutId, context_snapshot_json: snapshot })}`
        yield* sql`UPDATE versions SET rollout_id = ${rolloutId}, connection_id = ${connectionId},
          model_id = ${modelId}, updated_at = ${now} WHERE id = ${versionId}`
        yield* setVariables(chatId, slotId, versionId, variables, rolloutId, now)
        // A template message keeps what it first drew (frozen_macros, when it had none), and
        // its writes are recorded at its position once: a version with them recorded has them.
        yield* Effect.forEach(
          frozenMessages,
          ({ versionId: id, frozen, variables: writes }) =>
            Effect.gen(function* () {
              const [template] = yield* sql<{ slot_id: string; written: number }>`
                SELECT v.slot_id, EXISTS (SELECT 1 FROM state_events w WHERE w.version_id = v.id
                  AND w.key = 'var.set' AND w.origin = 'rollout') AS written
                FROM versions v JOIN slots s ON s.id = v.slot_id
                WHERE v.id = ${id} AND v.macro_mode = 'template' AND s.chat_id = ${chatId}`
              if (!template) return
              yield* sql`UPDATE versions SET frozen_macros = ${JSON.stringify(frozen)}
                WHERE id = ${id} AND frozen_macros IS NULL`
              if (template.written === 0) yield* setVariables(chatId, template.slot_id, id, writes, rolloutId, now)
            }),
          { discard: true }
        )
      }).pipe(transaction(sql, "StartRollout")),

    RecordSentContext: ({ userId, rolloutId, wire }) =>
      Effect.gen(function* () {
        yield* ownedRollout(userId, rolloutId)
        yield* sql`UPDATE rollout_payloads SET sent_context_json = ${wire} WHERE rollout_id = ${rolloutId}`
      }).pipe(transaction(sql, "RecordSentContext")),

    FinishRollout: ({ userId, rolloutId, versionId, status, error }) =>
      Effect.gen(function* () {
        yield* ownedRollout(userId, rolloutId)
        const [usage] = yield* sql<{
          requests: number
          input: number | null
          output: number | null
          cache_read: number | null
          cache_write: number | null
          cost: number | null
          currency: string | null
        }>`
          SELECT count(*) AS requests, sum(input_uncached) AS input, sum(output) AS output,
            sum(cache_read) AS cache_read, sum(cache_write) AS cache_write, sum(cost) AS cost,
            min(cost_currency) AS currency
          FROM llm_requests WHERE rollout_id = ${rolloutId}`
        const now = Date.now()
        yield* sql`UPDATE rollouts SET status = ${status}, error = ${error}, llm_requests = ${usage!.requests},
          usage_input_tokens = ${usage!.input}, usage_output_tokens = ${usage!.output},
          usage_cache_read_tokens = ${usage!.cache_read}, usage_cache_write_tokens = ${usage!.cache_write},
          usage_cost = ${usage!.cost}, completed_at = ${now}, updated_at = ${now}
          WHERE id = ${rolloutId} AND status = 'running'`
        yield* sql`UPDATE versions SET usage_json = ${JSON.stringify({
          requests: usage!.requests,
          inputUncached: usage!.input,
          output: usage!.output,
          cacheRead: usage!.cache_read,
          cacheWrite: usage!.cache_write,
          cost: usage!.cost,
          currency: usage!.currency
        })} WHERE id = ${versionId} AND rollout_id = ${rolloutId}`
      }).pipe(transaction(sql, "FinishRollout")),

    InterruptRollouts: () =>
      sql`UPDATE rollouts SET status = 'interrupted', updated_at = ${Date.now()}
          WHERE status IN ('created', 'running') RETURNING id`.pipe(
        Effect.map((rows) => ({ interrupted: rows.length })),
        transaction(sql, "InterruptRollouts")
      ),

    SetGenerationDefaults: ({ userId, defaults }) =>
      Effect.gen(function* () {
        const { model, preset } = defaults
        if (model !== null && !(yield* ownedModel(sql, userId, model.connection, model.model))) {
          return yield* new NotFound({ entity: "model", id: model.model })
        }
        if (preset !== null && !(yield* ownedPreset(sql, userId, preset))) {
          return yield* new NotFound({ entity: "ref", id: preset })
        }
        yield* putSetting(userId, DEFAULT_MODEL, model)
        yield* putSetting(userId, DEFAULT_PRESET, preset)
        return yield* readDefaults(sql, userId)
      }).pipe(transaction(sql, "SetGenerationDefaults"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
  return handlers
})
