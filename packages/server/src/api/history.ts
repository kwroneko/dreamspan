import { prepareHistory } from "../historyPreparation.ts"
import { Commands, makeCommand, runCommand } from "../commands.ts"
import { RenameHistoryInput, historyReadRpcs } from "@rp/shared/historyApi.ts"
import { HistoryRejected } from "@rp/shared/historyApi.ts"
import type { HistoryCursor, HistoryEdit } from "@rp/shared/historyApi.ts"
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { Effect, Schema } from "effect"
import type { ChatId, ForkId } from "@rp/shared/chat.ts"
import { Reader, Writer } from "../db/Database.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { internal } from "./internal.ts"

export const makeHistoryHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  const warmth = yield* CacheWarmth
  const changed = (chatIds: ReadonlyArray<ChatId>, forkId?: ForkId) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      for (const chatId of new Set(chatIds)) {
        hub.publish(chatId, { _tag: "Reload", ...(forkId ? { forkId } : {}) })
        hub.publish(chatId, { _tag: "Lcm", ...(forkId ? { forkId } : {}) })
      }
      if (forkId === undefined) yield* warmth.refreshUser(user.id)
    })
  const commands = yield* Commands
  const rename = (params: typeof RenameHistoryInput.Type) =>
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
            allViews: true,
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
      yield* writer.ApplyHistoryEdits(
        yield* prepareHistory(writer, {
          userId: user.id,
          title: `Rename ${params.oldName} to ${params.newName}`.slice(0, 200),
          applications
        })
      )
      yield* changed(applications.map((a) => a.chatId))
      return applications.length
    }).pipe(internal("RenameHistory"))
  const search = historyReadRpcs[0]
  yield* commands.register(
    makeCommand({
      id: "history.rename",
      description: "Rename text across selected history and summaries.",
      input: RenameHistoryInput,
      output: Schema.Int,
      execute: rename
    })
  )
  yield* commands.register(
    makeCommand({
      id: "history.search",
      description: "Preview bounded search and replacement matches without writing.",
      input: search.payloadSchema,
      output: search.successSchema,
      execute: (params) =>
        Effect.flatMap(CurrentUser, (user) => reader.PreviewHistory({ ...params, userId: user.id })).pipe(
          internal("PreviewHistory")
        )
    })
  )
  return {
    RenameHistory: (params) => runCommand(commands, "history.rename", params, Schema.Int),
    HistoryEditCost: (params) =>
      Effect.flatMap(CurrentUser, (user) => reader.HistoryEditCost({ ...params, userId: user.id })).pipe(
        internal("HistoryEditCost")
      ),
    PreviewHistory: (params) => runCommand(commands, "history.search", params, search.successSchema),
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
        const result = yield* writer.ApplyHistoryEdits(yield* prepareHistory(writer, { ...params, userId: user.id }))
        yield* changed(params.applications.map((a) => a.chatId))
        return result
      }).pipe(internal("ApplyHistoryEdits")),
    UndoHistoryEdit: (params) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const result = yield* writer.UndoHistoryEdit({ ...params, userId: user.id })
        yield* changed([params.chatId], params.forkId)
        return result
      }).pipe(internal("UndoHistoryEdit"))
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
})
