// The user's generation defaults in `user_settings`; one naming something gone reads as none.
import type { EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { GenerationDefaults } from "@rp/shared/generation.ts"
import { newChatLcm } from "@rp/shared/lcmSettings.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { ConnectionId, ModelId } from "@rp/shared/providers.ts"
import { GlobalRegex } from "@rp/shared/regexScripts.ts"
import { Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/sql"

export const DEFAULT_PERSONA = "chat.persona"
export const DEFAULT_MODEL = "generation.model"
export const DEFAULT_PRESET = "generation.preset"
export const DEFAULT_JUDGE = "generation.judge"
export const DEFAULT_LCM = "generation.lcm"
/** The account's global regex scripts and their revision (`GlobalRegex`). */
export const GLOBAL_REGEX = "regex.global"

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

/** A live, unarchived card in this account's persona folder. */
export const ownedPersona = (sql: SqlClient.SqlClient, userId: UserId, entityId: string) =>
  sql<{ n: number }>`
    SELECT count(*) AS n FROM entities e JOIN entity_tags t ON t.entity_id = e.id AND t.tag = 'persona'
    WHERE e.id = ${entityId} AND e.owner_user_id = ${userId} AND e.kind = 'card'
      AND e.deleted_at IS NULL AND e.archived_at IS NULL AND e.purged_at IS NULL`.pipe(
    Effect.map(([row]) => row?.n === 1)
  )

const setting = (sql: SqlClient.SqlClient, userId: UserId, key: string) =>
  sql<{ value_json: string }>`SELECT value_json FROM user_settings WHERE user_id = ${userId} AND key = ${key}`.pipe(
    Effect.map(([row]) => (row ? (JSON.parse(row.value_json) as unknown) : null))
  )

export const readDefaults = (sql: SqlClient.SqlClient, userId: UserId) =>
  Effect.gen(function* () {
    const model = (yield* setting(sql, userId, DEFAULT_MODEL)) as { connection?: unknown; model?: unknown } | null
    const preset = yield* setting(sql, userId, DEFAULT_PRESET)
    const persona = yield* setting(sql, userId, DEFAULT_PERSONA)
    const personaOk = typeof persona === "string" && (yield* ownedPersona(sql, userId, persona))
    const modelOk =
      typeof model?.connection === "string" &&
      typeof model.model === "string" &&
      (yield* ownedModel(sql, userId, model.connection, model.model))
    const presetOk = typeof preset === "string" && (yield* ownedPreset(sql, userId, preset))
    const stored = (yield* setting(sql, userId, DEFAULT_LCM)) as GenerationDefaults["lcm"] | null
    // A model that is gone reads as none, like the default model.
    const usable = (choice: { connection?: unknown; model?: unknown } | null | undefined) =>
      typeof choice?.connection === "string" && typeof choice.model === "string"
        ? ownedModel(sql, userId, choice.connection, choice.model)
        : Effect.succeed(false)
    const { fallback, ...rest } = stored ?? {}
    const lcm = stored ? { ...rest, ...((yield* usable(fallback)) ? { fallback } : {}) } : null
    const judge = (yield* setting(sql, userId, DEFAULT_JUDGE)) as { connection?: unknown; model?: unknown } | null
    return new GenerationDefaults({
      persona: personaOk ? (persona as EntityId) : null,
      model: modelOk ? { connection: model!.connection as ConnectionId, model: model!.model as ModelId } : null,
      ...(lcm ? { lcm } : {}),
      ...((yield* usable(judge))
        ? { judge: { connection: judge!.connection as ConnectionId, model: judge!.model as ModelId } }
        : {}),
      preset: presetOk ? (preset as RefId) : null
    })
  })

/**
 * The `lcm.settings` a new chat stores: a full copy of the account default as it resolves now
 * (DESIGN §8), so changing the default later leaves the chat as it was. An imported chat
 * starts off whatever the default says.
 */
export const newChatLcmSettings = (sql: SqlClient.SqlClient, userId: UserId, enabled?: boolean) =>
  Effect.map(setting(sql, userId, DEFAULT_LCM), (stored) =>
    newChatLcm(stored as GenerationDefaults["lcm"] | null, enabled)
  )

const decodeGlobalRegex = Schema.decodeUnknownOption(GlobalRegex)

/** The global regex scripts as stored; a value that doesn't decode reads as none, at its revision. */
export const readGlobalRegex = (sql: SqlClient.SqlClient, userId: UserId) =>
  Effect.map(setting(sql, userId, GLOBAL_REGEX), (stored): GlobalRegex => {
    const decoded = decodeGlobalRegex(stored)
    if (Option.isSome(decoded)) return decoded.value
    const revision = (stored as { revision?: unknown } | null)?.revision
    return { scripts: [], revision: typeof revision === "number" && Number.isSafeInteger(revision) ? revision : 0 }
  })
