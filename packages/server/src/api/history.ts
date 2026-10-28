import { HistoryRejected } from "@rp/shared/historyApi.ts"
import type { HistoryCursor, HistoryEdit } from "@rp/shared/historyApi.ts"
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { Effect } from "effect"
import type { ChatId } from "@rp/shared/chat.ts"
import { Reader, Writer } from "../db/Database.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { internal } from "./internal.ts"

export const makeHistoryHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  const warmth = yield* CacheWarmth
  const changed = (chatIds: ReadonlyArray<ChatId>) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      for (const chatId of new Set(chatIds)) {
        hub.publish(chatId, { _tag: "Reload" })
        hub.publish(chatId, { _tag: "Lcm" })
      }
      yield* warmth.refreshUser(user.id)
    })
  return {
    RenameHistory: (params) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const targets = yield* reader.RenameHistoryTargets({ userId: user.id, entityId: params.entityId })
        if (params.scope === "none") return 0
        const selected =
          params.scope === "all"
            ? targets
            : targets.filter((t) => t.chatId === params.chatId && t.forkId === params.forkId)
        const applications = []
        for (const target of selected) {
          let cursor: typeof HistoryCursor.Type | undefined
          const edits: HistoryEdit[] = []
          do {
            const page = yield* reader.PreviewHistory({
              userId: user.id,
              ...target,
              search: {
                pairs: [{ find: params.oldName, replace: params.newName }],
                matchCase: true,
                wholeWord: false,
                regex: false,
                preserveCase: false,
                messages: true,
                swipes: true,
                summaries: true
              },
              ...(cursor ? { cursor } : {})
            })
            edits.push(
              ...page.hits.map(({ kind, targetId, beforeId, before, after }) => ({
                kind,
                targetId,
                beforeId,
                before,
                after
              }))
            )
            if (edits.length > 10000)
              return yield* new HistoryRejected({ message: "Too many rename matches; narrow the scope." })
            cursor = page.next ?? undefined
          } while (cursor)
          if (edits.length) applications.push({ ...target, summariesIncluded: true, edits })
        }
        if (!applications.length) return 0
        yield* writer.ApplyHistoryEdits({
          userId: user.id,
          title: `Rename ${params.oldName} to ${params.newName}`.slice(0, 200),
          applications
        })
        yield* changed(applications.map((a) => a.chatId))
        return applications.length
      }).pipe(internal("RenameHistory")),
    HistoryEditCost: (params) =>
      Effect.flatMap(CurrentUser, (user) => reader.HistoryEditCost({ ...params, userId: user.id })).pipe(
        internal("HistoryEditCost")
      ),
    PreviewHistory: (params) =>
      Effect.flatMap(CurrentUser, (user) => reader.PreviewHistory({ ...params, userId: user.id })).pipe(
        internal("PreviewHistory")
      ),
    ListHistoryEdits: (params) =>
      Effect.flatMap(CurrentUser, (user) => reader.ListHistoryEdits({ ...params, userId: user.id })).pipe(
        internal("ListHistoryEdits")
      ),
    RenameHistoryTargets: (params) =>
      Effect.flatMap(CurrentUser, (user) => reader.RenameHistoryTargets({ ...params, userId: user.id })).pipe(
        internal("RenameHistoryTargets")
      ),
    ApplyHistoryEdits: (params) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const result = yield* writer.ApplyHistoryEdits({ ...params, userId: user.id })
        yield* changed(params.applications.map((a) => a.chatId))
        return result
      }).pipe(internal("ApplyHistoryEdits")),
    UndoHistoryEdit: (params) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const result = yield* writer.UndoHistoryEdit({ ...params, userId: user.id })
        yield* changed([params.chatId])
        return result
      }).pipe(internal("UndoHistoryEdit"))
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
})
