// What may hold back a new version of a reply before it's asked for (spec/WORKSHOP.md §3.4), beside
// `replyHooks`, whose `beforeReply` can't cancel: a guard can. The workshop registers the warning
// for a reply whose run changed things outside the chat; a plugin can replace, disable or add one.
import type { VersionId } from "@rp/shared/chat.ts"
import { makeRegistry } from "../../registry.ts"

export interface ReplyGuardRequest {
  readonly chatId: string
  /** The chat's kind where the caller knows it. */
  readonly kind: string | undefined
  /** The version a new one would replace in its slot. */
  readonly versionId: VersionId
  /** Its run made tool calls: only such a reply can have changed anything. */
  readonly hasSteps: boolean
  /** Regenerate or a swipe to a new version, or carrying on from one of its steps. */
  readonly action: "regenerate" | "resume-step"
}

export interface ReplyGuard {
  readonly id: string
  /** Resolves false to cancel the new version. */
  readonly check: (request: ReplyGuardRequest) => Promise<boolean>
}

export const replyGuards = makeRegistry<ReplyGuard>()

/** Whether every guard lets the new version be asked for, in order; the first to refuse stops it. */
export const guardReply = async (request: ReplyGuardRequest) => {
  for (const guard of replyGuards.list()) if (!(await guard.check(request))) return false
  return true
}
