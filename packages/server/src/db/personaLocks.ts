// Persona locks (DESIGN §2.2, owner 2026-11-18: "an explicit lock per-character"): one row per
// account and character card in `persona_locks` (0006_persona_locks), naming the persona that
// character's new single chats start with. A lock only chooses a new chat's starting persona;
// it never changes a chat that has started. Keyed by the card entity, as favourites are: a
// card fork is its own character (spec/LIBRARY-FORKS.md), with its own lock or none.
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { loadCastCards } from "./cards.ts"
import { ownedPersona } from "./generationSettings.ts"
import { NotFound, type ReadOps, type WriteOps } from "./ops.ts"
import { query, transaction } from "./tx.ts"

/** A card of the user's that is not purged; `live` also excludes the bin. */
const ownedCard = (sql: SqlClient.SqlClient, userId: UserId, entityId: EntityId, live: boolean) =>
  sql<{ id: string }>`SELECT id FROM entities WHERE id = ${entityId} AND owner_user_id = ${userId}
    AND kind = 'card' AND purged_at IS NULL ${live ? sql`AND deleted_at IS NULL` : sql``}`.pipe(
    Effect.flatMap(([row]) => (row ? Effect.void : Effect.fail(new NotFound({ entity: "card", id: entityId }))))
  )

/** The locked persona's id as stored, whether or not it can still be played. */
const storedPersonaLock = (sql: SqlClient.SqlClient, userId: UserId, entityId: EntityId) =>
  sql<{ persona_entity_id: string }>`SELECT persona_entity_id FROM persona_locks
    WHERE owner_user_id = ${userId} AND character_entity_id = ${entityId}`.pipe(
    Effect.map(([row]) => (row ? (row.persona_entity_id as EntityId) : null))
  )

export const makePersonaLockReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    GetPersonaLock: ({ userId, entityId }) =>
      Effect.gen(function* () {
        yield* ownedCard(sql, userId, entityId, false)
        const persona = yield* storedPersonaLock(sql, userId, entityId)
        // A binned, archived or no-longer-persona card reads as no lock, as the default does.
        if (persona === null || !(yield* ownedPersona(sql, userId, persona))) return null
        const [card] = yield* loadCastCards(sql, userId, [persona])
        return card ?? null
      }).pipe(query("GetPersonaLock"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})

export const makePersonaLockWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    SetPersonaLock: ({ userId, entityId, persona }) =>
      Effect.gen(function* () {
        yield* ownedCard(sql, userId, entityId, persona !== null)
        if (persona === null) {
          yield* sql`DELETE FROM persona_locks WHERE owner_user_id = ${userId} AND character_entity_id = ${entityId}`
          return
        }
        if (persona === entityId || !(yield* ownedPersona(sql, userId, persona)))
          return yield* new NotFound({ entity: "persona", id: persona })
        yield* sql`INSERT INTO persona_locks (owner_user_id, character_entity_id, persona_entity_id, updated_at)
          VALUES (${userId}, ${entityId}, ${persona}, ${Date.now()})
          ON CONFLICT (owner_user_id, character_entity_id)
          DO UPDATE SET persona_entity_id = excluded.persona_entity_id, updated_at = excluded.updated_at`
      }).pipe(transaction(sql, "SetPersonaLock"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
