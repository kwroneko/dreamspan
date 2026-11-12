// The regenerate warning (spec/WORKSHOP.md §3.6): a new version of a workshop reply, by Regenerate,
// a swipe or carrying on from one of its steps, doesn't undo what its run changed outside the chat,
// and the assistant may make the same changes again. The guard registered in `replyGuards` asks
// here; the one host in `appTools` (RegenerateWarning.tsx) reads the reply's changes and, when any
// still stand, asks in a dialog, so the asking survives the menu that asked closing.
import { useSyncExternalStore } from "react"
import type { ReplyGuardRequest } from "../chat/replyGuards.ts"
import { kindShows } from "../chat/kindLooks.ts"
import { CHANGES } from "./effects.ts"

export interface WarningRequest {
  readonly id: number
  readonly request: ReplyGuardRequest
  readonly settle: (go: boolean) => void
}

let current: WarningRequest | null = null
let next = 1
const listeners = new Set<() => void>()
const notify = () => {
  for (const listener of listeners) listener()
}

/** Whether a request can need the warning: a reply that made tool calls, in a kind with changes. */
export const mayWarn = (request: ReplyGuardRequest) =>
  request.hasSteps && (request.kind === undefined || kindShows(request.kind, CHANGES))

/** Asks the host; resolves whether the new version goes ahead. */
export const askBeforeReply = (request: ReplyGuardRequest): Promise<boolean> => {
  if (!mayWarn(request)) return Promise.resolve(true)
  // A second ask while one is open cancels the first.
  current?.settle(false)
  return new Promise<boolean>((resolve) => {
    const id = next++
    current = {
      id,
      request,
      settle: (go) => {
        if (current?.id === id) {
          current = null
          notify()
        }
        resolve(go)
      }
    }
    notify()
  })
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useWarningRequest = () => useSyncExternalStore(subscribe, () => current)
