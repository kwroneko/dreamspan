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
/** A device's layout is key `workbench:<device>`; keys between these two bounds are all of them. */
const WORKBENCH = "workbench:"
const WORKBENCH_END = "workbench;"
/** Devices whose layouts an account keeps; past it, the one that saved least recently goes. */
const MAX_WORKBENCH_DEVICES = 20

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
    GetDisplayPrefs: ({ userId }) => read(sql, userId).pipe(query("GetDisplayPrefs")),
    GetWorkbenchLayout: ({ userId, device }) =>
      sql<{ layout: string | null }>`SELECT json_extract(value_json, '$.layout') AS layout FROM user_prefs
          WHERE user_id = ${userId} AND key = ${WORKBENCH + device}`.pipe(
        Effect.map(([row]) => row?.layout ?? null),
        query("GetWorkbenchLayout")
      )
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})

/** Most choices a stored message toolbar keeps; past it, the oldest written go first. */
const MAX_TOOLBAR_CHOICES = 200

/**
 * The message toolbar's choices merge by action id, and the message details' by detail id:
 * a write names the ones it changes, so two devices pinning different actions (or hiding
 * different details) don't undo each other. The ones written go last.
 */
const mergeChoices = (stored: DisplayPrefs["messageToolbar"], changed: DisplayPrefs["messageToolbar"] | undefined) => {
  if (changed === undefined) return stored
  const kept = Object.entries(stored).filter(([id]) => !(id in changed))
  return Object.fromEntries([...kept, ...Object.entries(changed)].slice(-MAX_TOOLBAR_CHOICES))
}

export const makeDisplayPrefsWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    SetDisplayPrefs: ({ userId, prefs }) =>
      Effect.gen(function* () {
        const stored = yield* read(sql, userId)
        const merged = {
          ...stored,
          ...prefs,
          messageToolbar: mergeChoices(stored.messageToolbar, prefs.messageToolbar),
          dismissedInfo: mergeChoices(stored.dismissedInfo, prefs.dismissedInfo),
          messageDetails: mergeChoices(stored.messageDetails, prefs.messageDetails)
        }
        yield* sql`INSERT INTO user_prefs (user_id, key, value_json) VALUES (${userId}, ${KEY}, ${JSON.stringify(merged)})
          ON CONFLICT (user_id, key) DO UPDATE SET value_json = excluded.value_json`
        return yield* read(sql, userId)
      }).pipe(transaction(sql, "SetDisplayPrefs")),
    // The client repairs what it reads, so the layout is stored as written (the API checks it's a
    // JSON object), beside `at`: the account's count of layout saves when it was saved, which
    // orders the devices for pruning without a clock.
    SetWorkbenchLayout: ({ userId, device, layout }) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO user_prefs (user_id, key, value_json)
          SELECT ${userId}, ${WORKBENCH + device}, json_object('at', coalesce(max(json_extract(value_json, '$.at')), 0) + 1, 'layout', json(${layout}))
          FROM user_prefs WHERE user_id = ${userId} AND key > ${WORKBENCH} AND key < ${WORKBENCH_END}
          ON CONFLICT (user_id, key) DO UPDATE SET value_json = excluded.value_json`
        yield* sql`DELETE FROM user_prefs WHERE user_id = ${userId} AND key > ${WORKBENCH} AND key < ${WORKBENCH_END}
          AND key NOT IN (SELECT key FROM user_prefs WHERE user_id = ${userId} AND key > ${WORKBENCH} AND key < ${WORKBENCH_END}
            ORDER BY json_extract(value_json, '$.at') DESC LIMIT ${MAX_WORKBENCH_DEVICES})`
      }).pipe(transaction(sql, "SetWorkbenchLayout")),
    ForgetWorkbenchLayouts: ({ userId }) =>
      sql`DELETE FROM user_prefs WHERE user_id = ${userId} AND key > ${WORKBENCH} AND key < ${WORKBENCH_END}`.pipe(
        Effect.asVoid,
        transaction(sql, "ForgetWorkbenchLayouts")
      ),
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
