// The account's card-source choices (spec/CARD-SOURCES.md §5.2, §4.1): the per-source switch,
// the credential holding each source's key, the last content rating, and the recently viewed
// list. One row per user in `settings`, key `sources`, merged in the writer's transaction.
import { DEFAULT_SOURCE_PREFS, RECENT_REMOTE_MAX, SourcePrefs } from "@rp/shared/cardSources.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { ReadOps, WriteOps } from "./ops.ts"
import { putUserSetting } from "./settings.ts"
import { query, transaction } from "./tx.ts"

const KEY = "sources"
const decode = Schema.decodeUnknownOption(SourcePrefs)

const read = (sql: SqlClient.SqlClient, userId: UserId) =>
  sql<{
    value_json: string
  }>`SELECT value_json FROM settings WHERE scope = 'user' AND scope_id = ${userId} AND key = ${KEY}`.pipe(
    Effect.map(([row]): SourcePrefs => {
      if (!row) return DEFAULT_SOURCE_PREFS
      const stored = decode({ ...DEFAULT_SOURCE_PREFS, ...(JSON.parse(row.value_json) as object) })
      return stored._tag === "Some" ? stored.value : DEFAULT_SOURCE_PREFS
    })
  )

export const makeSourcePrefsReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    GetSourcePrefs: ({ userId }) => read(sql, userId).pipe(query("GetSourcePrefs"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})

/** Entries named `null` are removed; the rest replace what's stored under their source. */
const merge = <V>(stored: Readonly<Record<string, V>>, change: Readonly<Record<string, V | null>> | undefined) => {
  if (change === undefined) return stored
  const next: Record<string, V> = { ...stored }
  for (const [id, value] of Object.entries(change)) {
    if (value === null) delete next[id]
    else next[id] = value
  }
  return next
}

export const makeSourcePrefsWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const write = (userId: UserId, prefs: SourcePrefs) =>
    putUserSetting(sql, userId, KEY, prefs).pipe(Effect.andThen(read(sql, userId)))
  return {
    ChangeSourcePrefs: ({ userId, change }) =>
      Effect.gen(function* () {
        const stored = yield* read(sql, userId)
        return yield* write(userId, {
          ...stored,
          enabled: merge(stored.enabled, change.enabled),
          keys: merge(stored.keys, change.keys),
          // A rating of null is a choice ("the source's default"), so it's kept, not removed.
          rating: change.rating === undefined ? stored.rating : { ...stored.rating, ...change.rating }
        })
      }).pipe(transaction(sql, "ChangeSourcePrefs")),
    RecordRecentRemote: ({ userId, entry }) =>
      Effect.gen(function* () {
        const stored = yield* read(sql, userId)
        const others = stored.recent.filter((r) => r.sourceId !== entry.sourceId || r.remoteId !== entry.remoteId)
        return yield* write(userId, { ...stored, recent: [entry, ...others].slice(0, RECENT_REMOTE_MAX) })
      }).pipe(transaction(sql, "RecordRecentRemote")),
    ClearRecentRemote: ({ userId, sourceId }) =>
      Effect.gen(function* () {
        const stored = yield* read(sql, userId)
        return yield* write(userId, {
          ...stored,
          recent: sourceId === null ? [] : stored.recent.filter((r) => r.sourceId !== sourceId)
        })
      }).pipe(transaction(sql, "ClearRecentRemote"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
