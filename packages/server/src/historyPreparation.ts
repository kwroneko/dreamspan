// Main-thread orchestration only: each chunk is a short writer transaction over private
// TEMP data. The final existing write publishes everything, or refuses a changed snapshot.
import { Effect } from "effect"
import type { HistoryEdit } from "@dreamspan/shared/historyApi.ts"
import type { ChatId, ForkId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { Writer } from "./db/Database.ts"

interface Application {
  readonly chatId: ChatId
  readonly forkId: ForkId
  readonly edits: ReadonlyArray<HistoryEdit>
  readonly summariesIncluded?: boolean
  readonly summaryIds?: ReadonlyArray<string>
}
export const prepareHistory = Effect.fnUntraced(function* <
  A extends {
    readonly userId: UserId
    readonly groupId?: string
    readonly applications: ReadonlyArray<Application>
  }
>(writer: Pick<Writer["Service"], "PrepareHistoryEdits">, input: A) {
  if (input.applications.length !== 1) return input
  const app = input.applications[0]!
  let end = 0
  while (end < app.edits.length && app.edits[end]!.kind === "version_replace") end++
  if (end < 1000 || end > 10000 || app.edits.slice(end).some((e) => e.kind === "version_replace")) return input
  const edits = app.edits.slice(0, end)
  if (edits.reduce((n, e) => n + Buffer.byteLength(e.before, "utf8") + Buffer.byteLength(e.after, "utf8"), 0) > 8388608)
    return input
  let token: string | undefined
  for (let from = 0; from < edits.length; from += 500) {
    token = yield* writer.PrepareHistoryEdits({
      userId: input.userId,
      chatId: app.chatId,
      forkId: app.forkId,
      ...(input.groupId ? { groupId: input.groupId } : {}),
      ...(token ? { token } : {}),
      total: edits.length,
      summariesIncluded: app.summariesIncluded ?? false,
      ...(app.summaryIds === undefined ? {} : { summaryIds: app.summaryIds }),
      edits: edits.slice(from, from + 500)
    })
  }
  return { ...input, ...(token ? { prepared: token } : {}) }
})
