// What new workshops start with (spec/WORKSHOP-CONTEXT.md §4.3): the assistant card, the preset and
// the workshop persona, the user setting `workshop.defaults`. The persona is the workshop's own,
// independent of the story default (`chat.persona`): changing either never changes the other.
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { WorkshopDefaults } from "@dreamspan/shared/workshopApi.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { ownedPersona, readDefaults } from "./generationSettings.ts"
import { readSetting } from "./settings.ts"

export interface StoredWorkshopDefaults {
  readonly card: string
  readonly preset: string
  /** Absent: never chosen (the first workshop seeds one). Null: none. */
  readonly persona?: string | null
}

export const readStoredWorkshopDefaults = (sql: SqlClient.SqlClient, userId: UserId) =>
  Effect.map(
    readSetting(sql, "user", userId, "workshop.defaults"),
    ({ value }) => value as StoredWorkshopDefaults | null
  )

/** A live card of the user's (an entity id). */
export const ownedCard = (sql: SqlClient.SqlClient, userId: UserId, entityId: string) =>
  sql<{ n: number }>`SELECT count(*) AS n FROM entities WHERE id = ${entityId} AND owner_user_id = ${userId}
    AND kind = 'card' AND deleted_at IS NULL AND purged_at IS NULL`.pipe(Effect.map(([row]) => row?.n === 1))

/** The defaults as they stand: a default that was deleted or archived reads as none. */
export const workshopDefaultsOf = (sql: SqlClient.SqlClient, userId: UserId) =>
  Effect.gen(function* () {
    const stored = yield* readStoredWorkshopDefaults(sql, userId)
    if (!stored) return { card: null, preset: null, persona: null, makesPersona: true } satisfies WorkshopDefaults
    const persona =
      typeof stored.persona === "string" && (yield* ownedPersona(sql, userId, stored.persona)) ? stored.persona : null
    const card = (yield* ownedCard(sql, userId, stored.card)) ? stored.card : null
    const [preset] = yield* sql<{ id: string }>`SELECT r.id FROM entity_refs r JOIN entities e ON e.id = r.entity_id
      WHERE r.id = ${stored.preset} AND e.owner_user_id = ${userId} AND e.kind = 'preset' AND e.deleted_at IS NULL`
    return {
      card,
      preset: preset?.id ?? null,
      persona,
      ...(stored.persona === undefined ? { makesPersona: true } : {})
    } satisfies WorkshopDefaults
  })

/** Whether a persona is the account's story persona, or a card cast (joined or swapped in), played or speaking in `story`. */
export const personaInStory = (sql: SqlClient.SqlClient, userId: UserId, story: string, persona: string) =>
  Effect.gen(function* () {
    if ((yield* readDefaults(sql, userId)).persona === persona) return true
    const [hit] = yield* sql<{ n: number }>`SELECT 1 AS n FROM state_events
      WHERE chat_id = ${story} AND key IN ('participant.join', 'played_by_me.set', 'card.swap')
        AND (value_json ->> '$.entity' = ${persona}
          OR EXISTS (SELECT 1 FROM json_each(value_json, '$.entities') WHERE value = ${persona}))
      UNION ALL SELECT 1 FROM versions v JOIN slots s ON s.id = v.slot_id
        WHERE s.chat_id = ${story} AND v.speaker_entity_id = ${persona}
      LIMIT 1`
    return hit !== undefined
  })

export const workshopSpeaker = (picked: EntityId | null, assistant: EntityId, persona: EntityId | null) =>
  picked === assistant ? assistant : persona
