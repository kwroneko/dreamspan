import { BACKGROUND_BLUR, BACKGROUND_OPACITY, MAX_BACKGROUND_OVERRIDES } from "@dreamspan/shared/chatBackgrounds.ts"
import { NotFound } from "@dreamspan/shared/errors.ts"
import {
  backgroundHeldBy,
  backgroundKey,
  checkBackgroundChat,
  countLocalGalleries,
  MAX_BACKGROUNDS,
  MAX_LOCAL_BACKGROUNDS,
  MAX_LOCAL_GALLERIES,
  readBackgroundHolds
} from "./backgroundMedia.ts"
import { discardUnheldMedia, recordMediaReference, type MediaUpload } from "./media.ts"
import { putUserSetting } from "./settings.ts"
// The user's display choices in `settings` (DESIGN §7.4: reasoning's sticky open or folded
// state while a reply streams). One row per user, key `display`, merged atomically.
import { DEFAULT_DISPLAY_PREFS, DisplayPrefs, type DisplayPrefsChange } from "@dreamspan/shared/chatApi.ts"
import type { ChatId } from "@dreamspan/shared/chat.ts"
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
export const readDisplayPrefs = (sql: SqlClient.SqlClient, userId: UserId) =>
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
    ListChatBackgrounds: ({ userId, chatId }) =>
      Effect.gen(function* () {
        if (chatId !== undefined) yield* checkBackgroundChat(sql, userId, chatId)
        const gallery = yield* readBackgroundHolds(sql, userId, chatId)
        return gallery.map(({ mediaId, name, addedAt }) => ({ mediaId, name, addedAt }))
      }).pipe(query("ListChatBackgrounds")),
    GetDisplayPrefs: ({ userId }) => readDisplayPrefs(sql, userId).pipe(query("GetDisplayPrefs"))
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

export const recordBackground = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  name: string,
  media: MediaUpload,
  chatId?: ChatId
) {
  if (chatId !== undefined) yield* checkBackgroundChat(sql, userId, chatId)
  const gallery = yield* readBackgroundHolds(sql, userId, chatId)
  const [asset] = yield* sql<{ id: string; galleryOnly: number }>`
    SELECT id, ${backgroundHeldBy(sql, "media_assets.id", userId, true)} AS galleryOnly
    FROM media_assets WHERE sha256 = ${media.sha256}`
  const existing = asset && gallery.find((entry) => entry.mediaId === asset.id)
  if (existing) return { mediaId: existing.mediaId, addedAt: null }
  if (gallery.length >= (chatId === undefined ? MAX_BACKGROUNDS : MAX_LOCAL_BACKGROUNDS)) return null
  if (
    chatId !== undefined &&
    gallery.length === 0 &&
    (yield* countLocalGalleries(sql, userId))[0]!.count >= MAX_LOCAL_GALLERIES
  )
    return null
  const { mediaId, created } = yield* recordMediaReference(sql, userId, media, true)
  const addedAt = Date.now()
  yield* putUserSetting(sql, userId, backgroundKey(chatId), [
    { mediaId, name, addedAt, galleryOnly: created || asset?.galleryOnly === 1 },
    ...gallery
  ])
  return { mediaId, addedAt }
})

const saveGallery = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: ChatId | undefined,
  gallery: ReadonlyArray<unknown>
) =>
  chatId !== undefined && gallery.length === 0
    ? Effect.asVoid(
        sql`DELETE FROM settings WHERE scope = 'user' AND scope_id = ${userId} AND key = ${backgroundKey(chatId)}`
      )
    : Effect.asVoid(putUserSetting(sql, userId, backgroundKey(chatId), gallery))

const releaseBackground = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  entry: { readonly galleryOnly: boolean; readonly mediaId: string }
) {
  if (!entry.galleryOnly) return null
  const { mediaId } = entry
  yield* sql`DELETE FROM media_refs WHERE media_id = ${mediaId} AND owner_user_id = ${userId}
    AND NOT ${backgroundHeldBy(sql, "media_refs.media_id", userId)}`
  return (yield* discardUnheldMedia(sql, mediaId))[0]?.sha256 ?? null
})

export const deleteBackground = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  mediaId: string,
  chatId?: ChatId,
  addedAt?: number
) {
  if (chatId !== undefined) yield* checkBackgroundChat(sql, userId, chatId)
  const gallery = yield* readBackgroundHolds(sql, userId, chatId)
  const entry = gallery.find((entry) => entry.mediaId === mediaId)
  if (!entry || (addedAt !== undefined && entry.addedAt !== addedAt))
    return yield* new NotFound({ entity: "background", id: mediaId })
  const stored = yield* readDisplayPrefs(sql, userId)
  const chatBackground =
    chatId === undefined && stored.chatBackground.mediaId === mediaId
      ? { ...stored.chatBackground, mediaId: null }
      : stored.chatBackground
  const workshopBackground =
    chatId === undefined && stored.workshopBackground === mediaId ? "inherit" : stored.workshopBackground
  const kept = { ...stored.chatBackgrounds }
  const global = chatId === undefined ? [] : yield* readBackgroundHolds(sql, userId)
  for (const [id, selected] of Object.entries(kept)) {
    if (selected !== mediaId || (chatId !== undefined && id !== chatId)) continue
    const other = chatId === undefined ? yield* readBackgroundHolds(sql, userId, id) : global
    if (!other.some((entry) => entry.mediaId === mediaId)) delete kept[id]
  }
  yield* putUserSetting(sql, userId, KEY, { ...stored, chatBackground, workshopBackground, chatBackgrounds: kept })
  yield* saveGallery(
    sql,
    userId,
    chatId,
    gallery.filter((item) => item.mediaId !== mediaId)
  )
  return yield* releaseBackground(sql, userId, entry)
})

/** Called after permanent removal, when the chat and its references can no longer be restored. */
export const purgeChatBackgrounds = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: ChatId
) {
  const gallery = yield* readBackgroundHolds(sql, userId, chatId)
  if (gallery.length > 0) {
    yield* saveGallery(sql, userId, chatId, [])
    for (const entry of gallery) yield* releaseBackground(sql, userId, entry)
  }
  const stored = yield* readDisplayPrefs(sql, userId)
  if (Object.hasOwn(stored.chatBackgrounds, chatId)) {
    const chatBackgrounds = { ...stored.chatBackgrounds }
    delete chatBackgrounds[chatId]
    yield* putUserSetting(sql, userId, KEY, { ...stored, chatBackgrounds })
  }
})

export const changeDisplayPrefs = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  { inheritChatBackground, ...prefs }: DisplayPrefsChange
) {
  const stored = yield* readDisplayPrefs(sql, userId)
  const backgroundPatch = prefs.chatBackground
  const overridePatch = Object.entries(prefs.chatBackgrounds ?? {})
  const globalChoices = [
    backgroundPatch?.mediaId,
    prefs.workshopBackground === "inherit" ? undefined : prefs.workshopBackground
  ]
  const gallery =
    globalChoices.some((id) => typeof id === "string") || overridePatch.some(([, id]) => typeof id === "string")
      ? yield* readBackgroundHolds(sql, userId)
      : []
  for (const id of globalChoices) {
    if (typeof id === "string" && !gallery.some((entry) => entry.mediaId === id))
      return yield* new NotFound({ entity: "background", id })
  }
  for (const [id, choice] of overridePatch) {
    yield* checkBackgroundChat(sql, userId, id)
    if (typeof choice !== "string" || gallery.some((entry) => entry.mediaId === choice)) continue
    const local = yield* readBackgroundHolds(sql, userId, id)
    if (!local.some((entry) => entry.mediaId === choice))
      return yield* new NotFound({ entity: "background", id: choice })
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
  return yield* readDisplayPrefs(sql, userId)
})

export const makeDisplayPrefsWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    RecordChatBackground: ({ userId, name, media, chatId }) =>
      recordBackground(sql, userId, name, media, chatId).pipe(
        Effect.map((recorded) => recorded?.mediaId ?? null),
        transaction(sql, "RecordChatBackground")
      ),
    DeleteChatBackground: ({ userId, mediaId, chatId }) =>
      deleteBackground(sql, userId, mediaId, chatId).pipe(transaction(sql, "DeleteChatBackground")),
    SetDisplayPrefs: ({ userId, prefs }) =>
      changeDisplayPrefs(sql, userId, prefs).pipe(transaction(sql, "SetDisplayPrefs"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
