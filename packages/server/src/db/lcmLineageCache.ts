// Sealed lineage and primary slot/version identities are immutable. Freshness never lives here.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

interface Entry<A> {
  readonly stamp: string
  readonly children: ReadonlyArray<A>
  readonly valid: boolean | undefined
  readonly weight: number
}
export const makeLineageCache = <A>(maxEntries = 4096, maxCharacters = 4_000_000) => {
  const entries = new Map<string, Entry<A>>()
  let characters = 0
  return {
    get: (id: string, stamp: string) => {
      const entry = entries.get(id)
      if (!entry || entry.stamp !== stamp) return undefined
      entries.delete(id)
      entries.set(id, entry)
      return entry
    },
    set: (id: string, stamp: string, children: ReadonlyArray<A>, valid: boolean | undefined) => {
      const old = entries.get(id)
      if (old) {
        characters -= old.weight
        entries.delete(id)
      }
      const weight = id.length + stamp.length + JSON.stringify(children).length
      if (weight > maxCharacters) return
      while (entries.size >= maxEntries || characters + weight > maxCharacters) {
        const oldest = entries.keys().next().value!
        characters -= entries.get(oldest)!.weight
        entries.delete(oldest)
      }
      entries.set(id, { stamp, children, valid, weight })
      characters += weight
    }
  }
}

const guards = [
  "summaries_immutable",
  "summaries_retained",
  "summaries_no_replace",
  "summaries_selection_frozen",
  "summary_inputs_immutable",
  "summary_inputs_retained",
  "summary_inputs_closed",
  "summary_inputs_no_replace",
  "summary_parents_immutable",
  "summary_parents_retained",
  "summary_parents_closed",
  "summary_parents_no_replace",
  "summary_revisions_immutable",
  "summary_revisions_retained",
  "summary_revisions_no_replace",
  "slots_parent_same_chat",
  "slots_shape_fixed",
  "slots_chain_assigned",
  "slots_selection_own_version",
  "slots_selection_own_version_update",
  "summary_inputs_version_in_slot",
  "summary_inputs_version_in_slot_update",
  "slots_chain_fixed",
  "versions_identity_fixed"
]
const connections = new WeakMap<
  SqlClient.SqlClient,
  { version: number; enabled: boolean; cache: ReturnType<typeof makeLineageCache<unknown>> }
>()

/** A schema change flushes the cache; missing immutability guards disable it (including corruption fixtures). */
export const lineageCache = <A>(sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const [schema] = yield* sql<{ schema_version: number }>`PRAGMA schema_version`
    let state = connections.get(sql)
    if (!state || state.version !== schema!.schema_version) {
      const [row] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM sqlite_schema
      WHERE type='trigger' AND name IN (SELECT value FROM json_each(${JSON.stringify(guards)}))`
      state = {
        version: schema!.schema_version,
        enabled: row!.count === guards.length,
        cache: makeLineageCache<unknown>()
      }
      connections.set(sql, state)
    }
    return state.enabled ? (state.cache as ReturnType<typeof makeLineageCache<A>>) : undefined
  })
