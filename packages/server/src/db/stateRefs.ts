// What a state event's value refers to (DATA-MODEL §5.3), as its key declares it
// (`stateKeyIds` in @rp/shared/state.ts). The writer checks it against the acting user
// before the event is written: an id the user doesn't own is NotFound, as everywhere
// else, and so is a deleted one, except when the event removes it. Reads leave out what
// a purge removed for good.
import type { UserId } from "@rp/shared/domain.ts"
import type { EntityKind } from "@rp/shared/library.ts"
import {
  type FoldableEvent,
  isStateRole,
  scopeIds,
  type WritableStateEvent,
  type StateKeyDeclaration,
  stateKeys
} from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { NotFound, StorageError } from "./ops.ts"

type Reference =
  | {
      readonly table: "entity"
      readonly id: string
      readonly kind: EntityKind
      readonly chatOwned?: true | "required"
      readonly allowDeleted?: true
    }
  /** A ref of `entity` when given. */
  | { readonly table: "ref"; readonly id: string; readonly kind: EntityKind; readonly entity: string | undefined }
  /** A revision of `entity`, or of the entity of `ref`, when given. */
  | {
      readonly table: "revision"
      readonly id: string
      readonly kind: EntityKind
      readonly entity: string | undefined
      readonly ref: string | undefined
    }
  | { readonly table: "connection"; readonly id: string }
  | { readonly table: "model"; readonly id: string; readonly connection: string | undefined }

type Declared = StateKeyDeclaration

/** A participant scope is checked like a value's ids; a role names nothing. */
const scopeReferences = (scope: FoldableEvent["scope"]) =>
  scope === null || isStateRole(scope) ? [] : referencesOf(scopeIds, { scope })

/** What a stored event names; a plugin key nobody registered now names nothing, so its events are kept. */
const references = (data: FoldableEvent["data"]) => {
  const key = stateKeys.get(data.key)
  // Schema changes can leave older values that no longer have these id fields.
  return key === undefined || !key.accepts(data.value) ? [] : referencesOf(key.ids, data.value)
}

const referencesOf = (declared: Declared, of: unknown): ReadonlyArray<Reference> => {
  // A value that isn't an object declares no fields, so this is only read for objects.
  const value = of as Readonly<Record<string, string | ReadonlyArray<string> | null | undefined>>
  const field = (name: string | undefined) => (name === undefined ? undefined : (value[name] as string | undefined))
  return Object.entries(declared.ids).flatMap(([name, declaration]) => {
    if (declaration === undefined) return []
    const held = value[name]
    const ids = held == null ? [] : typeof held === "string" ? [held] : held
    return ids.map((id): Reference => {
      switch (declaration.table) {
        case "entity":
          return {
            table: "entity",
            id,
            kind: declaration.kind,
            ...(declaration.chatOwned ? { chatOwned: declaration.chatOwned } : {}),
            ...(declaration.allowDeleted ? { allowDeleted: true } : {})
          }
        case "ref":
          return { table: "ref", id, kind: declaration.kind, entity: field(declaration.entity) }
        case "revision":
          return {
            table: "revision",
            id,
            kind: declaration.kind,
            entity: field(declaration.entity),
            ref: field(declaration.ref)
          }
        case "connection":
          return { table: "connection", id }
        case "model":
          return { table: "model", id, connection: field(declaration.connection) }
      }
    })
  })
}

export const checkStateReferences = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: string,
  data: WritableStateEvent,
  scope: FoldableEvent["scope"]
) => {
  // A key nobody registered is refused, whatever its value holds.
  const key = stateKeys.get(data.key)
  if (key === undefined) return Effect.fail(new NotFound({ entity: "unavailable state key", id: data.key }))
  const declaration = key.ids
  if (!key.accepts(data.value))
    return Effect.fail(
      new StorageError({
        reason: "constraint",
        operation: "state event",
        message: `Invalid value for state key "${data.key}"`
      })
    )
  // Keys that take something out of the state work on deleted and purged things too.
  const live = declaration.removes ? 0 : 1
  return Effect.forEach(
    [...references(data), ...scopeReferences(scope)],
    (reference) => {
      const count = (() => {
        switch (reference.table) {
          case "entity":
            return sql<{ n: number }>`SELECT count(*) AS n FROM entities WHERE id = ${reference.id}
              AND owner_user_id = ${userId} AND kind = ${reference.kind} AND (${reference.allowDeleted ? 0 : live} = 0 OR deleted_at IS NULL)
              AND (${reference.chatOwned ? 1 : 0} = 0 OR NOT EXISTS (
                SELECT 1 FROM entity_refs r JOIN entity_revisions v ON v.id = r.head_revision_id
                WHERE r.entity_id = ${reference.id}
                  AND json_extract(v.doc_json, '$.owner.chat') IS NOT NULL
                  AND json_extract(v.doc_json, '$.owner.chat') <> ${chatId}))
              AND (${reference.chatOwned === "required" ? 1 : 0} = 0 OR EXISTS (
                SELECT 1 FROM entity_refs r JOIN entity_revisions v ON v.id = r.head_revision_id
                WHERE r.entity_id = ${reference.id}
                  AND json_extract(v.doc_json, '$.owner.chat') = ${chatId}))`
          case "ref":
            return sql<{ n: number }>`SELECT count(*) AS n FROM entity_refs r JOIN entities e ON e.id = r.entity_id
              WHERE r.id = ${reference.id} AND e.owner_user_id = ${userId} AND e.kind = ${reference.kind}
                AND (${live} = 0 OR e.deleted_at IS NULL)
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
              WHERE m.id = ${reference.id} AND m.connection_id = ${reference.connection ?? null} AND c.owner_user_id = ${userId}`
        }
      })()
      return Effect.gen(function* () {
        if ((yield* count)[0]?.n === 1) return
        // Retain a purged summary choice already stored by this user. This lets existing
        // settings remain editable and new chats copy their default while using fallback.
        if (data.key === "lcm.settings" && reference.table === "ref") {
          const [retained] = yield* sql<{ ok: number }>`SELECT
            NOT EXISTS (SELECT 1 FROM entity_refs WHERE id=${reference.id}) AND (
              EXISTS (SELECT 1 FROM settings WHERE scope = 'user' AND scope_id = ${userId} AND key='generation.lcm'
                AND json_extract(value_json, '$.preset')=${reference.id}) OR
              EXISTS (SELECT 1 FROM state_events e JOIN chats c ON c.id=e.chat_id
                WHERE c.id=${chatId} AND c.owner_user_id=${userId} AND e.key='lcm.settings'
                  AND json_extract(e.value_json, '$.preset')=${reference.id})
            ) AS ok`
          if (retained?.ok === 1) return
        }
        return yield* new NotFound({ entity: reference.table, id: reference.id })
      })
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
export const withoutPurged = <E extends FoldableEvent>(
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<E>,
  partition: (event: E) => string = () => ""
) =>
  Effect.gen(function* () {
    const ids = { entity: new Set<string>(), ref: new Set<string>(), revision: new Set<string>() }
    for (const event of events) {
      for (const reference of [...references(event.data), ...scopeReferences(event.scope)]) {
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
    // A purged card may still be the routing identity of an independent live fork.
    // Keep only the cast fields that reach a live card through the remaining swaps;
    // neither its definitions nor its dormant bindings survive the purge.
    const groups = new Map<string, Array<E>>()
    for (const event of events) {
      const key = partition(event)
      const group = groups.get(key) ?? []
      group.push(event)
      groups.set(key, group)
    }
    const routingByGroup = new Map<string, Set<string>>()
    const keptSwaps = new Set<E>()
    for (const [key, group] of groups) {
      const destinations = new Map<string, string>()
      for (const event of [...group].reverse()) {
        const { data } = event
        if (data.key !== "card.swap") continue
        // A purged incoming card still makes its event disappear, as before.
        // It can remain only as an intermediate on the way to a live card.
        if (gone.has(data.value.entity) && !destinations.has(data.value.entity)) continue
        keptSwaps.add(event)
        destinations.set(data.value.replaces, destinations.get(data.value.entity) ?? data.value.entity)
      }
      routingByGroup.set(
        key,
        new Set(
          [...gone].filter((id) => {
            const destination = destinations.get(id)
            return destination !== undefined && !gone.has(destination)
          })
        )
      )
    }
    return events.flatMap((event): ReadonlyArray<FoldableEvent> => {
      const routing = routingByGroup.get(partition(event))!
      if (scopeReferences(event.scope).some((reference) => gone.has(reference.id))) return []
      // Summary settings retain an unavailable preset for fallback and the settings warning;
      // dropping this event would also lose its switch, instruction and token bands.
      if (event.data.key === "lcm.settings") return [event]
      if (!references(event.data).some((reference) => gone.has(reference.id))) return [event]
      const { data } = event
      if (data.key === "card.swap") {
        return keptSwaps.has(event) ? [event] : []
      }
      if (
        ["participant.join", "participant.leave", "presence.set", "lorebook.binding", "lorebook.embedded"].includes(
          data.key
        ) &&
        references(data).every(
          (r) => !gone.has(r.id) || (r.table === "entity" && r.kind === "card" && routing.has(r.id))
        )
      )
        return [event]
      // Only this key names several entities; the rest of the set still applies.
      if (event.data.key === "played_by_me.set") {
        const entities = event.data.value.entities.filter((id) => !gone.has(id) || routing.has(id))
        return [{ ...event, data: { key: event.data.key, value: { entities } } }]
      }
      return []
    })
  })
