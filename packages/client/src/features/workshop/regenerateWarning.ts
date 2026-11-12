// The regenerate warning (spec/WORKSHOP.md §3.6): a new version of a workshop reply, by Regenerate,
// a swipe or carrying on from one of its steps, doesn't undo what its run changed outside the chat,
// and the assistant may make the same changes again. The guard registered in `replyGuards` asks
// here; the one host in `appTools` (RegenerateWarning.tsx) reads the reply's changes and, when any
// still stand, asks in a dialog, so the asking survives the menu that asked closing.
import { useSyncExternalStore } from "react"
import type { RolloutStep } from "@rp/shared/agent.ts"
import type { ReplyGuardRequest } from "../chat/replyGuards.ts"
import { kindShows } from "../chat/kindLooks.ts"
import { CHANGES } from "./effects.ts"
import { outstanding, type RolloutEffect } from "./effects.ts"
import type { CallResult } from "../editor/caller.ts"

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

/**
 * What a new version does and doesn't do (spec/WORKSHOP.md §3.4, §3.6, W5's merged rules): it
 * keeps the reply's own calls (before the step it carries on from) and their changes, undoes
 * nothing, and the run may make the later changes again.
 */
export const warningText = (action: "regenerate" | "resume-step") =>
  action === "regenerate"
    ? "Made by the replies its run wrote after this one. A new version keeps this reply’s own steps and changes and undoes none of these, but the assistant may make them again."
    : "Made from this step on, or by the replies its run wrote after this one. Carrying on keeps the steps before it and their changes and undoes none of these, but the assistant may make them again."

/**
 * The calls a new version keeps, by id, from the version's own steps: all of them for a new
 * version of the reply (only its message is written again); for carrying on from a step, those
 * before it, and the step's own call when its result is edited in place.
 */
export const keptCalls = (steps: ReadonlyArray<RolloutStep>, request: ReplyGuardRequest) =>
  new Set(
    steps
      .slice(0, request.fromStep ? request.fromStep.index + (request.fromStep.keepsCall ? 1 : 0) : steps.length)
      .flatMap((step) => (step.kind === "tool" ? [step.id] : []))
  )

/** A failed read cannot prove there were no changes, or which calls regeneration retains. */
export const warningEffects = (
  request: ReplyGuardRequest,
  effects: CallResult<ReadonlyArray<RolloutEffect>>,
  steps: CallResult<ReadonlyArray<RolloutStep>>
): CallResult<ReadonlyArray<RolloutEffect>> => {
  if (!effects.ok) return effects
  const left = outstanding(effects.value)
  if (left.length === 0) return { ok: true, value: [] }
  if (!steps.ok) return steps
  const kept = keptCalls(steps.value, request)
  return { ok: true, value: left.filter((effect) => !kept.has(effect.toolCallId)) }
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
