// The account's selections (GenerationDefaults), which every chat's next reply uses: read once
// for every picker, and read again when a write names "settings".
import { RegistryContext } from "@effect/atom-react"
import type { Atom } from "effect/reactivity"
import { useContext, useEffect } from "react"
import { AppClient } from "../../rpc.ts"
import type { ChatSession } from "../chat/session.ts"

export const defaultsAtom = AppClient.query("GetGenerationDefaults", undefined, { reactivityKeys: ["settings"] })

/** Reads asked for in this turn of the event loop, sent once at its end. */
const asked = new Set<Atom.Atom<unknown>>()

/**
 * Reads `atom` again whenever the chat says its next context changed (another tab or device can
 * change the account's choices). The composer's chips, the Model and Prompt preset tabs all
 * follow one change: they share one read, where each refreshing made one apiece (night/tabperf).
 */
export function useRefreshOnContext(session: ChatSession | null, atom: Atom.Atom<unknown>) {
  const registry = useContext(RegistryContext)
  useEffect(
    () =>
      session?.subscribeContext(() => {
        if (asked.has(atom)) return
        asked.add(atom)
        queueMicrotask(() => {
          asked.delete(atom)
          registry.refresh(atom)
        })
      }),
    [session, atom, registry]
  )
}
