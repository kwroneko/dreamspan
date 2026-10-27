// The user's display choices in `user_prefs` (DESIGN §7.4: reasoning's sticky open or folded
// state while a reply streams). One row per user, key `display`, merged atomically.
import { DEFAULT_DISPLAY_PREFS, DisplayPrefs } from "@rp/shared/chatApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { ReadOps, WriteOps } from "./ops.ts"
import { query, transaction } from "./tx.ts"

const KEY = "display"
const NOTICES = "notices"

/** Reasoning streams open until the user folds it during a run (DESIGN §7.4). */
const DEFAULTS = DEFAULT_DISPLAY_PREFS

const decode = Schema.decodeUnknownOption(DisplayPrefs)

/** What's stored, over the defaults; a value this version doesn't know reads as the default. */
const read = (sql: SqlClient.SqlClient, userId: UserId) =>
  sql<{ value_json: string }>`SELECT value_json FROM user_prefs WHERE user_id = ${userId} AND key = ${KEY}`.pipe(
    Effect.map(([row]) => {
      if (!row) return DEFAULTS
      const stored = decode({ ...DEFAULTS, ...(JSON.parse(row.value_json) as object) })
      return stored._tag === "Some" ? stored.value : DEFAULTS
    })
  )

export const makeDisplayPrefsReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    GetDisplayPrefs: ({ userId }) => read(sql, userId).pipe(query("GetDisplayPrefs"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})

export const makeDisplayPrefsWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    SetDisplayPrefs: ({ userId, prefs }) =>
      Effect.gen(function* () {
        const merged = { ...(yield* read(sql, userId)), ...prefs }
        yield* sql`INSERT INTO user_prefs (user_id, key, value_json) VALUES (${userId}, ${KEY}, ${JSON.stringify(merged)})
          ON CONFLICT (user_id, key) DO UPDATE SET value_json = excluded.value_json`
        return yield* read(sql, userId)
      }).pipe(transaction(sql, "SetDisplayPrefs")),
    // One-time notices, by notice, as the keys they were shown for (key `notices`).
    MarkNoticeShown: ({ userId, notice, key }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ value_json: string }>`
          SELECT value_json FROM user_prefs WHERE user_id = ${userId} AND key = ${NOTICES}`
        const stored = row ? (JSON.parse(row.value_json) as Record<string, unknown>) : {}
        const shown = Array.isArray(stored[notice]) ? (stored[notice] as Array<unknown>) : []
        if (shown.includes(key)) return false
        const value = JSON.stringify({ ...stored, [notice]: [...shown, key] })
        yield* sql`INSERT INTO user_prefs (user_id, key, value_json) VALUES (${userId}, ${NOTICES}, ${value})
          ON CONFLICT (user_id, key) DO UPDATE SET value_json = excluded.value_json`
        return true
      }).pipe(transaction(sql, "MarkNoticeShown"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
