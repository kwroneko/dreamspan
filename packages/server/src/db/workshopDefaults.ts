// What new workshops start with (spec/WORKSHOP-CONTEXT.md §4.3): the assistant card, the preset and
// the workshop persona, the user setting `workshop.defaults`. The persona is the workshop's own,
// independent of the story default (`chat.persona`): changing either never changes the other.
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { WorkshopDefaults } from "@dreamspan/shared/workshopApi.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { ownedPersona } from "./generationSettings.ts"
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
