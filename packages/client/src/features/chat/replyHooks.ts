// What other features do around a reply (spec/PLUGINS.md §8): before one is asked for, and when
// a chat's state changed (a reply cut a revision of what it used, say). The editor registers
// its live-text flush and refresh here (owner, 2026-11-01: what you see is what's sent); a
// plugin can replace, disable or add to them.
import { makeRegistry } from "../../registry.ts"

export interface ReplyHook {
  readonly id: string
  /** Runs before a reply is asked for; the request waits for it, its failure doesn't stop it. */
  readonly beforeReply?: () => Promise<unknown>
  /** A chat's state changed on the server. */
  readonly stateChanged?: (chatId: string) => void
}

export const replyHooks = makeRegistry<ReplyHook>()

export const beforeReply = () =>
  Promise.allSettled(replyHooks.list().map((hook) => hook.beforeReply?.())).then(() => undefined)

export const chatStateChanged = (chatId: string) => {
  for (const hook of replyHooks.list()) hook.stateChanged?.(chatId)
}
