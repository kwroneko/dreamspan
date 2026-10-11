// What a state event's value refers to (DATA-MODEL §5.3). The writer checks it against
// the acting user before the event is written: an id the user doesn't own is NotFound,
// as everywhere else, and so is a deleted one, except when the event removes it. Reads
// leave out what a purge removed for good.
import type { UserId } from "@rp/shared/domain.ts"
import type { EntityKind } from "@rp/shared/library.ts"
import type { FoldableEvent, StateEventData } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { NotFound } from "./ops.ts"

type Reference =
  | { readonly table: "entity"; readonly id: string; readonly kind: EntityKind }
  /** A ref of `entity` when given; a chat override only of this chat. */
  | { readonly table: "ref"; readonly id: string; readonly kind: EntityKind; readonly entity?: string }
  /** A revision of `entity`, or of the entity of `ref`, when given. */
  | {
      readonly table: "revision"
      readonly id: string
      readonly kind: EntityKind
      readonly entity?: string
      readonly ref?: string | undefined
    }
  | { readonly table: "connection"; readonly id: string }
  | { readonly table: "model"; readonly id: string; readonly connection: string }

const optional = <A>(value: string | undefined, f: (id: string) => A) => (value === undefined ? [] : [f(value)])

/**
 * Every id the value names. The switch is exhaustive, so a new key doesn't compile
 * until it's listed here.
 */
const references = (data: StateEventData): ReadonlyArray<Reference> => {
  switch (data.key) {
    case "participant.join":
    case "participant.leave":
    case "presence.set":
      return [{ table: "entity", id: data.value.entity, kind: "card" }]
    case "played_by_me.set":
      return data.value.entities.map((id) => ({ table: "entity", id, kind: "card" }))
    case "card.binding": {
      const { entity, ref, revision } = data.value
      return [
        { table: "entity", id: entity, kind: "card" },
        ...optional(ref, (id) => ({ table: "ref", id, kind: "card", entity }) as const),
        ...optional(revision, (id) => ({ table: "revision", id, kind: "card", entity }) as const)
      ]
    }
    case "note.activate":
    case "note.deactivate":
    case "author_note.set":
      return [{ table: "entity", id: data.value.note, kind: "note" }]
    case "note.binding":
      return [
        { table: "entity", id: data.value.note, kind: "note" },
        { table: "revision", id: data.value.revision, kind: "note", entity: data.value.note }
      ]
    case "preset.binding": {
      const { ref, revision } = data.value
      return [
        ...optional(ref, (id) => ({ table: "ref", id, kind: "preset" }) as const),
        ...optional(revision, (id) => ({ table: "revision", id, kind: "preset", ref }) as const)
      ]
    }
    case "preset_overlay.binding":
      return [{ table: "entity", id: data.value.overlay, kind: "preset_overlay" }]
    case "model.binding":
      return [
        { table: "connection", id: data.value.connection },
        { table: "model", id: data.value.model, connection: data.value.connection }
      ]
    case "lorebook.attach":
    case "lorebook.detach":
      return [{ table: "ref", id: data.value.ref, kind: "lorebook" }]
    case "layout.cards":
    case "roles.projection":
    case "macro.binding":
    case "orchestration.mode":
    case "output.contract":
    case "rollout.continuity":
    case "var.set":
      return []
  }
}

/** Keys that take something out of the state: they work on deleted and purged things too. */
const removals = new Set<StateEventData["key"]>([
  "participant.leave",
  "presence.set",
  "note.deactivate",
  "lorebook.detach"
])

export const checkStateReferences = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: string,
  data: StateEventData
) => {
  const live = removals.has(data.key) ? 0 : 1
  return Effect.forEach(
    references(data),
    (reference) => {
      const count = (() => {
        switch (reference.table) {
          case "entity":
            return sql<{ n: number }>`SELECT count(*) AS n FROM entities WHERE id = ${reference.id}
              AND owner_user_id = ${userId} AND kind = ${reference.kind} AND (${live} = 0 OR deleted_at IS NULL)`
          case "ref":
            return sql<{ n: number }>`SELECT count(*) AS n FROM entity_refs r JOIN entities e ON e.id = r.entity_id
              WHERE r.id = ${reference.id} AND e.owner_user_id = ${userId} AND e.kind = ${reference.kind}
                AND (${live} = 0 OR e.deleted_at IS NULL) AND (r.chat_id IS NULL OR r.chat_id = ${chatId})
                AND (${reference.entity ?? null} IS NULL OR r.entity_id = ${reference.entity ?? null})`
          case "revision":
            return sql<{ n: number }>`SELECT count(*) AS n FROM entity_revisions v JOIN entities e ON e.id = v.entity_id
              WHERE v.id = ${reference.id} AND e.owner_user_id = ${userId} AND e.kind = ${reference.kind}
                AND e.deleted_at IS NULL
                AND (${reference.entity ?? null} IS NULL OR v.entity_id = ${reference.entity ?? null})
                AND (${reference.ref ?? null} IS NULL
                  OR v.entity_id = (SELECT entity_id FROM entity_refs WHERE id = ${reference.ref ?? null}))`
          case "connection":
            return sql<{ n: number }>`SELECT count(*) AS n FROM connections WHERE id = ${reference.id}
              AND owner_user_id = ${userId} AND deleted_at IS NULL AND purged_at IS NULL`
          case "model":
            return sql<{ n: number }>`SELECT count(*) AS n FROM models m JOIN connections c ON c.id = m.connection_id
              WHERE m.id = ${reference.id} AND m.connection_id = ${reference.connection} AND c.owner_user_id = ${userId}`
        }
      })()
      return Effect.flatMap(count, ([row]) =>
        row?.n === 1 ? Effect.void : Effect.fail(new NotFound({ entity: reference.table, id: reference.id }))
      )
    },
    { discard: true }
  )
}

/**
 * Leaves out of `events` the library entities, refs and revisions a purge removed for
 * good, so nothing (restoring a message, deleting a later `participant.leave`) can bring
 * them back into a chat's state. A deleted entity still counts: it can be restored.
 * Connections stay: a binding to a purged one should fail visibly, not fall back.
 */
export const withoutPurged = (sql: SqlClient.SqlClient, events: ReadonlyArray<FoldableEvent>) =>
  Effect.gen(function* () {
    const ids = { entity: new Set<string>(), ref: new Set<string>(), revision: new Set<string>() }
    for (const event of events) {
      for (const reference of references(event.data)) {
        if (reference.table in ids) ids[reference.table as keyof typeof ids].add(reference.id)
      }
    }
    const gone = new Set<string>()
    const list = (set: Set<string>) => [...set]
    if (ids.entity.size > 0) {
      const rows = yield* sql<{ id: string }>`SELECT id FROM entities
        WHERE id IN ${sql.in(list(ids.entity))} AND purged_at IS NOT NULL`
      for (const row of rows) gone.add(row.id)
    }
    // Purging an entity deletes its refs and revisions.
    for (const [table, set] of [
      ["entity_refs", ids.ref],
      ["entity_revisions", ids.revision]
    ] as const) {
      if (set.size === 0) continue
      const rows = yield* sql<{ id: string }>`SELECT id FROM ${sql(table)} WHERE id IN ${sql.in(list(set))}`
      const present = new Set(rows.map((row) => row.id))
      for (const id of set) if (!present.has(id)) gone.add(id)
    }
    if (gone.size === 0) return events
    return events.flatMap((event): ReadonlyArray<FoldableEvent> => {
      if (!references(event.data).some((reference) => gone.has(reference.id))) return [event]
      // Only this key names several entities; the rest of the set still applies.
      if (event.data.key === "played_by_me.set") {
        const entities = event.data.value.entities.filter((id) => !gone.has(id))
        return [{ ...event, data: { key: event.data.key, value: { entities } } }]
      }
      return []
    })
  })
