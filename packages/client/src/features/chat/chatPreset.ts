// The prompt preset the open chat's next reply is built with: the context estimate's, or, in
// a chat without one yet (a chat with no messages has none), the account's selected preset.
// The Prompt preset tab edits it; the Lorebooks tab lists the books it sends.
import type { RefId } from "@dreamspan/shared/library.ts"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { defaultsAtom, useRefreshOnContext } from "../pickers/defaults.ts"
import type { ChatSession, ChatView } from "./session.ts"

/**
 * The account's selected preset, the next reply's when the chat has no context estimate yet: a
 * chat without messages has none, so the tab would otherwise wait for a first message. A chat
 * not made yet (no session) uses it too.
 */
export function useSelectedPreset(session: ChatSession | null) {
  // The pickers' read, shared: a read of its own here was one more at every chat open (night/tabperf).
  const result = useAtomValue(defaultsAtom)
  useRefreshOnContext(session, defaultsAtom)
  return AsyncResult.isSuccess(result) ? { ref: result.value.preset as RefId | null } : null
}

/** The preset's ref (undefined while loading), and whether it's ST's built-in default (no ref). */
export function useChatPreset(session: ChatSession, view: ChatView) {
  const selected = useSelectedPreset(session)
  // The estimate names the preset the next reply is assembled with (a chat's own copy, say);
  // until there is one, the account's selection.
  const estimated = view.history?.preset
  const ref = (estimated ? estimated.ref : selected?.ref) as RefId | null | undefined
  const builtin = estimated ? estimated.scope === "builtin" : selected !== null && selected.ref === null
  return { ref: ref ?? undefined, builtin }
}
