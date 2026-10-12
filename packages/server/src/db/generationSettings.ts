// The user's generation defaults in `user_settings`; one naming something gone reads as none.
import type { UserId } from "@rp/shared/domain.ts"
import { GenerationDefaults } from "@rp/shared/generation.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { ConnectionId, ModelId } from "@rp/shared/providers.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

export const DEFAULT_MODEL = "generation.model"
export const DEFAULT_PRESET = "generation.preset"

/** A live connection of the user's and a model of it. */
export const ownedModel = (sql: SqlClient.SqlClient, userId: UserId, connection: string, model: string) =>
  sql<{ n: number }>`
    SELECT count(*) AS n FROM models m JOIN connections c ON c.id = m.connection_id
    WHERE m.id = ${model} AND c.id = ${connection} AND c.owner_user_id = ${userId}
      AND c.deleted_at IS NULL AND c.purged_at IS NULL`.pipe(Effect.map(([row]) => row?.n === 1))

/** A live preset ref of the user's, not a chat override. */
export const ownedPreset = (sql: SqlClient.SqlClient, userId: UserId, ref: string) =>
  sql<{ n: number }>`
    SELECT count(*) AS n FROM entity_refs r JOIN entities e ON e.id = r.entity_id
    WHERE r.id = ${ref} AND e.owner_user_id = ${userId} AND e.kind = 'preset' AND e.deleted_at IS NULL
      AND r.ref_kind <> 'chat_override'`.pipe(Effect.map(([row]) => row?.n === 1))

const setting = (sql: SqlClient.SqlClient, userId: UserId, key: string) =>
  sql<{ value_json: string }>`SELECT value_json FROM user_settings WHERE user_id = ${userId} AND key = ${key}`.pipe(
    Effect.map(([row]) => (row ? (JSON.parse(row.value_json) as unknown) : null))
  )

export const readDefaults = (sql: SqlClient.SqlClient, userId: UserId) =>
  Effect.gen(function* () {
    const model = (yield* setting(sql, userId, DEFAULT_MODEL)) as { connection?: unknown; model?: unknown } | null
    const preset = yield* setting(sql, userId, DEFAULT_PRESET)
    const modelOk =
      typeof model?.connection === "string" &&
      typeof model.model === "string" &&
      (yield* ownedModel(sql, userId, model.connection, model.model))
    const presetOk = typeof preset === "string" && (yield* ownedPreset(sql, userId, preset))
    return new GenerationDefaults({
      model: modelOk ? { connection: model!.connection as ConnectionId, model: model!.model as ModelId } : null,
      preset: presetOk ? (preset as RefId) : null
    })
  })
