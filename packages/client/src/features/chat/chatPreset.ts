// The prompt preset the open chat's next reply is built with: the context estimate's, or, in
// a chat without one yet (a chat with no messages has none), the account's selected preset.
// The Prompt preset tab edits it; the Lorebooks tab lists the books it sends.
import type { RefId } from "@rp/shared/library.ts"
import { useEffect, useState } from "react"
import { useCaller } from "../editor/caller.ts"
import type { ChatSession, ChatView } from "./session.ts"

/**
 * The account's selected preset, the next reply's when the chat has no context estimate yet: a
 * chat without messages has none, so the tab would otherwise wait for a first message.
 */
function useSelectedPreset(session: ChatSession) {
  const call = useCaller()
  const [selected, setSelected] = useState<{ readonly ref: RefId | null } | null>(null)
  useEffect(() => {
    let live = true
    const refresh = () =>
      void call((client) => client("GetGenerationDefaults", undefined)).then((result) => {
        if (live && result.ok) setSelected({ ref: result.value.preset })
      })
    const unsubscribe = session.subscribeContext(refresh)
    refresh()
    return () => {
      live = false
      unsubscribe()
    }
  }, [session, call])
  return selected
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
