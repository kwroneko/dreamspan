import type { ChatId } from "@dreamspan/shared/chat.ts"
import type { DisplayPrefs, DisplayPrefsChange } from "@dreamspan/shared/chatApi.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { EffectUndoRefused, type RolloutEffect } from "@dreamspan/shared/workshopApi.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { WriteOps } from "./ops.ts"
import { changeDisplayPrefs, deleteBackground, readDisplayPrefs, recordBackground } from "./displayPrefs.ts"
import { checkBackgroundChat, readBackgroundHolds } from "./backgroundMedia.ts"
import { isDeepStrictEqual } from "node:util"

type Input = Parameters<Parameters<typeof WriteOps.of>[0]["AgentSetBackground"]>[0]
type Recipe = {
  readonly chatId?: ChatId
  readonly before: DisplayPrefsChange
  readonly after: DisplayPrefsChange
  readonly evicted?: readonly [string, string | null]
  readonly imported?: { readonly mediaId: string; readonly addedAt: number }
}

const selectChat = (chatId: ChatId, choice: string | null | undefined): DisplayPrefsChange =>
  choice === undefined || choice === "inherit"
    ? { inheritChatBackground: chatId }
    : { chatBackgrounds: { [chatId]: choice } }

const snapshot = (prefs: DisplayPrefs, mask: DisplayPrefsChange, chatId?: ChatId): DisplayPrefsChange => ({
  ...(chatId === undefined ? {} : selectChat(chatId, prefs.chatBackgrounds[chatId])),
  ...(mask.workshopBackground === undefined ? {} : { workshopBackground: prefs.workshopBackground }),
  ...(mask.chatBackground === undefined
    ? {}
    : {
        chatBackground: {
          ...(mask.chatBackground.mediaId === undefined ? {} : { mediaId: prefs.chatBackground.mediaId }),
          ...(mask.chatBackground.fit === undefined ? {} : { fit: prefs.chatBackground.fit }),
          ...(mask.chatBackground.opacity === undefined ? {} : { opacity: prefs.chatBackground.opacity }),
          ...(mask.chatBackground.blur === undefined ? {} : { blur: prefs.chatBackground.blur })
        }
      })
})

export const backgroundSetup = Effect.fnUntraced(function* (sql: SqlClient.SqlClient, input: Input) {
  const { userId, scope, chatId, imported, appearance } = input
  if ((scope === "chat") !== (chatId !== undefined))
    return yield* new EffectUndoRefused({ message: "Choose a chat for the chat scope." })
  if (chatId !== undefined) yield* checkBackgroundChat(sql, userId, chatId)
  const before = yield* readDisplayPrefs(sql, userId)
  const entry = imported ? yield* recordBackground(sql, userId, imported.name, imported.media, chatId) : null
  if (imported && entry === null) return yield* new EffectUndoRefused({ message: "The background gallery is full." })
  const choice = entry?.mediaId ?? input.choice
  if (choice === "inherit" && scope === "default")
    return yield* new EffectUndoRefused({ message: "The main background can be an image or solid." })
  const { fit, opacity, blur } = appearance
  const patch: DisplayPrefsChange = {
    ...(chatId === undefined || choice === undefined ? {} : selectChat(chatId, choice)),
    ...(scope === "workshop" && choice !== undefined ? { workshopBackground: choice } : {}),
    ...(scope === "chat"
      ? {}
      : {
          chatBackground: {
            ...(scope === "default" && choice !== undefined ? { mediaId: choice } : {}),
            ...(fit === undefined ? {} : { fit }),
            ...(opacity === undefined ? {} : { opacity }),
            ...(blur === undefined ? {} : { blur })
          }
        })
  }
  const saved = yield* changeDisplayPrefs(sql, userId, patch)
  const evicted =
    chatId === undefined
      ? undefined
      : Object.entries(before.chatBackgrounds).find(
          ([id]) => id !== chatId && !Object.hasOwn(saved.chatBackgrounds, id)
        )
  const undo: Recipe = {
    ...(chatId === undefined ? {} : { chatId }),
    before: snapshot(before, patch, chatId),
    ...(evicted === undefined ? {} : { evicted }),
    after: snapshot(saved, patch, chatId),
    ...(entry?.addedAt == null ? {} : { imported: { mediaId: entry.mediaId, addedAt: entry.addedAt } })
  }
  const effects =
    undo.imported || !isDeepStrictEqual(undo.before, undo.after)
      ? [
          {
            kind: "setup.background",
            targetKind: "setting",
            targetId: chatId ?? scope,
            title:
              scope === "default"
                ? "Changed the main background"
                : scope === "workshop"
                  ? "Changed the workshop background"
                  : "Changed a chat background",
            undo
          }
        ]
      : []
  return { result: input.result, effects }
})

const matches = Effect.fnUntraced(function* (sql: SqlClient.SqlClient, userId: UserId, recipe: Recipe) {
  const prefs = yield* readDisplayPrefs(sql, userId)
  if (!isDeepStrictEqual(snapshot(prefs, recipe.after, recipe.chatId), recipe.after)) return false
  if (recipe.evicted && Object.hasOwn(prefs.chatBackgrounds, recipe.evicted[0])) return false
  if (!recipe.imported) return true
  const { mediaId, addedAt } = recipe.imported
  return (yield* readBackgroundHolds(sql, userId, recipe.chatId)).some(
    (entry) => entry.mediaId === mediaId && entry.addedAt === addedAt
  )
})

export const backgroundUndo = {
  id: "setup.background",
  unchanged: (sql: SqlClient.SqlClient, userId: UserId, effect: RolloutEffect) =>
    matches(sql, userId, effect.undo as Recipe),
  run: Effect.fnUntraced(function* (
    { sql, userId }: { readonly sql: SqlClient.SqlClient; readonly userId: UserId },
    effect: RolloutEffect
  ) {
    const recipe = effect.undo as Recipe
    if (!(yield* matches(sql, userId, recipe)))
      return yield* new EffectUndoRefused({ message: "The background changed. Undo newer changes first." })
    if (recipe.chatId !== undefined) yield* checkBackgroundChat(sql, userId, recipe.chatId)
    const { evicted } = recipe
    const restore =
      evicted === undefined
        ? recipe.before
        : { ...recipe.before, chatBackgrounds: { ...recipe.before.chatBackgrounds, [evicted[0]]: evicted[1] } }
    yield* changeDisplayPrefs(sql, userId, restore)
    if (!recipe.imported) return {}
    const { mediaId, addedAt } = recipe.imported
    const discardedHash = yield* deleteBackground(sql, userId, mediaId, recipe.chatId, addedAt)
    return { discardedHash }
  })
}
