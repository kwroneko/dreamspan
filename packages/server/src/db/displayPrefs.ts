import { BACKGROUND_BLUR, BACKGROUND_OPACITY, MAX_BACKGROUND_OVERRIDES } from "@dreamspan/shared/chatBackgrounds.ts"
import { NotFound } from "@dreamspan/shared/errors.ts"
import { BACKGROUNDS_KEY, MAX_BACKGROUNDS, readBackgroundHolds } from "./backgroundMedia.ts"
import { discardUnheldMedia, recordMediaReference } from "./media.ts"
import { listed } from "./listedChats.ts"
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
    ListChatBackgrounds: ({ userId }) =>
      readBackgroundHolds(sql, userId).pipe(
        Effect.map((gallery) => gallery.map(({ mediaId, name, addedAt }) => ({ mediaId, name, addedAt }))),
        query("ListChatBackgrounds")
      ),
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

const roundedWithin = (value: number, range: { min: number; max: number }) =>
  Math.min(range.max, Math.max(range.min, Math.round(value)))

export const makeDisplayPrefsWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    RecordChatBackground: ({ userId, name, media }) =>
      Effect.gen(function* () {
        const gallery = yield* readBackgroundHolds(sql, userId)
        const [asset] = yield* sql<{ id: string }>`SELECT id FROM media_assets WHERE sha256 = ${media.sha256}`
        if (asset && gallery.some((entry) => entry.mediaId === asset.id)) return asset.id
        if (gallery.length >= MAX_BACKGROUNDS) return null
        const { mediaId, created } = yield* recordMediaReference(sql, userId, media, true)
        yield* putUserSetting(sql, userId, BACKGROUNDS_KEY, [
          { mediaId, name, addedAt: Date.now(), galleryOnly: created },
          ...gallery
        ])
        return mediaId
      }).pipe(transaction(sql, "RecordChatBackground")),

    DeleteChatBackground: ({ userId, mediaId }) =>
      Effect.gen(function* () {
        const gallery = yield* readBackgroundHolds(sql, userId)
        const entry = gallery.find((entry) => entry.mediaId === mediaId)
        if (!entry) return yield* new NotFound({ entity: "background", id: mediaId })
        const stored = yield* read(sql, userId)
        const chatBackground =
          stored.chatBackground.mediaId === mediaId
            ? { ...stored.chatBackground, mediaId: null }
            : stored.chatBackground
        const overrides = Object.entries(stored.chatBackgrounds)
        const kept = overrides.filter(([, value]) => value !== mediaId)
        if (chatBackground !== stored.chatBackground || overrides.length !== kept.length)
          yield* putUserSetting(sql, userId, KEY, {
            ...stored,
            chatBackground,
            chatBackgrounds: Object.fromEntries(kept)
          })
        yield* putUserSetting(
          sql,
          userId,
          BACKGROUNDS_KEY,
          gallery.filter((item) => item.mediaId !== mediaId)
        )
        if (!entry.galleryOnly) return null
        yield* sql`DELETE FROM media_refs WHERE media_id = ${mediaId} AND owner_user_id = ${userId}`
        return (yield* discardUnheldMedia(sql, mediaId))[0]?.sha256 ?? null
      }).pipe(transaction(sql, "DeleteChatBackground")),

    SetDisplayPrefs: ({ userId, prefs: { inheritChatBackground, ...prefs } }) =>
      Effect.gen(function* () {
        const stored = yield* read(sql, userId)
        const backgroundPatch = prefs.chatBackground
        const overridePatch = Object.entries(prefs.chatBackgrounds ?? {})
        const requested = [backgroundPatch?.mediaId, ...overridePatch.map(([, id]) => id)].filter(
          (id): id is string => typeof id === "string"
        )
        if (requested.length) {
          const gallery = new Set((yield* readBackgroundHolds(sql, userId)).map(({ mediaId }) => mediaId))
          const unknown = requested.find((id) => !gallery.has(id))
          if (unknown !== undefined) return yield* new NotFound({ entity: "background", id: unknown })
        }
        if (overridePatch.length) {
          const ids = overridePatch.map(([id]) => id)
          const owned = yield* sql<{ id: string }>`SELECT c.id FROM chats c
            WHERE c.owner_user_id = ${userId} AND ${listed(sql, "c")} AND c.id IN ${sql.in(ids)}
            UNION SELECT f.id FROM forks f JOIN chats c ON c.id = f.chat_id
            WHERE c.owner_user_id = ${userId} AND ${listed(sql, "c")} AND f.split_chat = 1 AND f.deleted_at IS NULL
              AND f.id IN ${sql.in(ids)}`
          const allowed = new Set(owned.map(({ id }) => id))
          const unknown = ids.find((id) => !allowed.has(id))
          if (unknown !== undefined) return yield* new NotFound({ entity: "chat", id: unknown })
        }
        const chatBackground = { ...stored.chatBackground, ...backgroundPatch }
        chatBackground.opacity = roundedWithin(chatBackground.opacity, BACKGROUND_OPACITY)
        chatBackground.blur = roundedWithin(chatBackground.blur, BACKGROUND_BLUR)
        const overrides = new Map(Object.entries(stored.chatBackgrounds))
        for (const [id, choice] of overridePatch) {
          overrides.delete(id)
          overrides.set(id, choice)
        }
        if (inheritChatBackground !== undefined) overrides.delete(inheritChatBackground)
        const merged = {
          ...stored,
          ...prefs,
          chatBackground,
          chatBackgrounds: Object.fromEntries([...overrides].slice(-MAX_BACKGROUND_OVERRIDES)),
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
      }).pipe(transaction(sql, "SetDisplayPrefs"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
