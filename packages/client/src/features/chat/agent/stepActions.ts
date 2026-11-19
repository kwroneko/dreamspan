// What a tool step's row offers under it (spec/WORKSHOP.md §3.4, §3.6): the agent feature
// registers the answer to a call waiting for the user, the workshop its changes' Undo and Open.
// A plugin can add, replace or disable one; a registration with nothing for a step renders
// nothing.
import type { RolloutStep } from "@dreamspan/shared/agent.ts"
import type { Version } from "@dreamspan/shared/chat.ts"
import { useSyncExternalStore, type ComponentType } from "react"
import { makeRegistry } from "../../../registry.ts"
import type { ChatSession } from "../session.ts"

type ToolStep = Extract<RolloutStep, { kind: "tool" }>

export interface StepActionProps {
  readonly step: ToolStep
  /** The reply the step belongs to. */
  readonly version: Version
  readonly session: ChatSession
}

export interface StepAction {
  readonly id: string
  readonly order: number
  readonly component: ComponentType<StepActionProps>
}

export const stepActions = makeRegistry<StepAction>()

/** The registered step actions, in order, re-rendering when they change. */
export const useStepActions = () => {
  const snapshot = useSyncExternalStore(stepActions.subscribe, stepActions.snapshot, stepActions.snapshot)
  return [...snapshot.entries].sort((a, b) => a.order - b.order)
}

/** Whether any of these steps, or a subagent one started, waits for the user's answer. */
export const waitsForUser = (steps: ReadonlyArray<RolloutStep> | null | undefined) =>
  steps?.some(
    (step) =>
      step.kind === "tool" &&
      (step.status === "waiting" ||
        step.subagent?.steps?.some((child) => child.kind === "tool" && child.status === "waiting") === true)
  ) ?? false
