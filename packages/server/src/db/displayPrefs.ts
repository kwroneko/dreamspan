import { putUserSetting } from "./settings.ts"
// The user's display choices in `settings` (DESIGN §7.4: reasoning's sticky open or folded
// state while a reply streams). One row per user, key `display`, merged atomically.
import { DEFAULT_DISPLAY_PREFS, DisplayPrefs } from "@dreamspan/shared/chatApi.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
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
    GetDisplayPrefs: ({ userId }) => read(sql, userId).pipe(query("GetDisplayPrefs"))
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
          messageDetails: mergeChoices(stored.messageDetails, prefs.messageDetails),
          stateMarkers: mergeChoices(stored.stateMarkers, prefs.stateMarkers)
        }
        yield* putUserSetting(sql, userId, KEY, merged)
        return yield* read(sql, userId)
      }).pipe(transaction(sql, "SetDisplayPrefs")),
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
