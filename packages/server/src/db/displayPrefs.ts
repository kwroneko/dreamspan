import { deviceScopeId, putUserSetting, writeSetting } from "./settings.ts"
// The user's display choices in `settings` (DESIGN §7.4: reasoning's sticky open or folded
// state while a reply streams). One row per user, key `display`, merged atomically.
import { DEFAULT_DISPLAY_PREFS, DisplayPrefs } from "@rp/shared/chatApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { ReadOps, WriteOps } from "./ops.ts"
import { query, transaction } from "./tx.ts"

const KEY = "display"
const NOTICES = "notices"
const WORKBENCH = "workbench"
/** Devices whose layouts an account keeps; past it, the one that saved least recently goes. */
const MAX_WORKBENCH_DEVICES = 20

/** Reasoning streams open until the user folds it during a run (DESIGN §7.4). */
const DEFAULTS = DEFAULT_DISPLAY_PREFS

const decode = Schema.decodeUnknownOption(DisplayPrefs)

/** What's stored, over the defaults; a value this version doesn't know reads as the default. */
const read = (sql: SqlClient.SqlClient, userId: UserId) =>
  sql<{
    value_json: string
  }>`SELECT value_json FROM settings WHERE scope = 'user' AND scope_id = ${userId} AND key = ${KEY}`.pipe(
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
      sql<{ layout: string | null }>`SELECT json_extract(value_json, '$.layout') AS layout FROM settings
          WHERE scope = 'device' AND scope_id = ${deviceScopeId(userId, device)} AND key = ${WORKBENCH}`.pipe(
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
          modelPins: Object.fromEntries(Object.entries({ ...stored.modelPins, ...prefs.modelPins }).slice(-500)),
          modelRecent: Object.fromEntries(
            Object.entries({ ...stored.modelRecent, ...prefs.modelRecent })
              .map(([id, at]) => [id, Math.max(at, stored.modelRecent[id] ?? 0)] as const)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 100)
          ),
          messageToolbar: mergeChoices(stored.messageToolbar, prefs.messageToolbar),
          dismissedInfo: mergeChoices(stored.dismissedInfo, prefs.dismissedInfo),
          messageDetails: mergeChoices(stored.messageDetails, prefs.messageDetails)
        }
        yield* putUserSetting(sql, userId, KEY, merged)
        return yield* read(sql, userId)
      }).pipe(transaction(sql, "SetDisplayPrefs")),
    // Layouts are repaired by the client; the ordinal keeps pruning deterministic without a clock.
    SetWorkbenchLayout: ({ userId, device, layout }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ at: number }>`SELECT coalesce(max(json_extract(value_json, '$.at')), 0) + 1 AS at
          FROM settings WHERE scope = 'device' AND key = ${WORKBENCH} AND json_extract(scope_id, '$[0]') = ${userId}`
        yield* writeSetting(sql, "device", deviceScopeId(userId, device), WORKBENCH, {
          at: row!.at,
          layout: JSON.parse(layout)
        }).pipe(Effect.catchTag("StaleWrite", Effect.die))
        yield* sql`DELETE FROM settings WHERE scope = 'device' AND key = ${WORKBENCH}
          AND json_extract(scope_id, '$[0]') = ${userId}
          AND scope_id NOT IN (SELECT scope_id FROM settings WHERE scope = 'device' AND key = ${WORKBENCH}
            AND json_extract(scope_id, '$[0]') = ${userId}
            ORDER BY json_extract(value_json, '$.at') DESC LIMIT ${MAX_WORKBENCH_DEVICES})`
      }).pipe(transaction(sql, "SetWorkbenchLayout")),
    ForgetWorkbenchLayouts: ({ userId }) =>
      sql`DELETE FROM settings WHERE scope = 'device' AND key = ${WORKBENCH} AND json_extract(scope_id, '$[0]') = ${userId}`.pipe(
        Effect.asVoid,
        transaction(sql, "ForgetWorkbenchLayouts")
      ),
    // One-time notices, by notice, as the keys they were shown for (key `notices`).
    MarkNoticeShown: ({ userId, notice, key }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ value_json: string }>`
          SELECT value_json FROM settings WHERE scope = 'user' AND scope_id = ${userId} AND key = ${NOTICES}`
        const stored = row ? (JSON.parse(row.value_json) as Record<string, unknown>) : {}
        const shown = Array.isArray(stored[notice]) ? (stored[notice] as Array<unknown>) : []
        if (shown.includes(key)) return false
        yield* putUserSetting(sql, userId, NOTICES, { ...stored, [notice]: [...shown, key] })
        return true
      }).pipe(transaction(sql, "MarkNoticeShown"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
