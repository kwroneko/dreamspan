// The agent RPCs (@rp/shared/agentApi.ts). Storage checks the version or chat is the caller's.
import { foldState } from "@rp/shared/state.ts"
import { ACTIVITY_PAGE, NotResumable, type StepEdit } from "@rp/shared/agent.ts"
import { type AgentApi } from "@rp/shared/agentApi.ts"
import { CurrentUser } from "@rp/shared/api.ts"
import type { ForkId, VersionId } from "@rp/shared/chat.ts"
import { GenerationUnavailable } from "@rp/shared/chatApi.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect, Option } from "effect"
import { planResume, planStepResume, type ResumePlan, StepNotResumable } from "../agent/resume.ts"
import { countSteps } from "../agent/steps.ts"
import type { FrozenTool } from "../agent/tools.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { Generations } from "../chat/Generations.ts"
import { Generator } from "../chat/Generator.ts"
import { Reader, Writer } from "../db/Database.ts"
import { ExecutionRegistry } from "../execution.ts"
import { internal } from "./internal.ts"

/** What a resume needs of the stopped run's frozen snapshot. */
interface Frozen {
  readonly inputs?: { readonly model?: { readonly prefill?: string } | null }
  readonly agent?: { readonly tools?: ReadonlyArray<FrozenTool> }
}

export const makeAgentHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  const generations = yield* Generations
  const generator = yield* Generator

  /**
   * A new version that carries on `versionId`'s run as `plan` keeps it (spec/AGENTIC.md §4.2):
   * written with its rollout in one transaction, then generated from the kept transcript.
   */
  const resume = (
    versionId: VersionId,
    forkId: ForkId | null,
    expectedRowVersion: number,
    plan: (
      material: { readonly status: string; readonly transcript: string | null },
      frozen: Frozen
    ) => ResumePlan | StepNotResumable,
    reason: "resume" | "edit"
  ) =>
    Effect.gen(function* () {
      if (Option.isNone(generator))
        return yield* new GenerationUnavailable({ message: "This server has nothing to generate with." })
      const userId = (yield* CurrentUser).id
      const refuse = (message: string) => Effect.fail(new NotResumable({ versionId, message }))
      const material = yield* reader.RolloutMaterial({ userId, versionId })
      if (material.mode === null) return yield* refuse("It wasn't written with tools.")
      if (material.versionStatus === "generating" || material.status === "running")
        return yield* refuse("It's still being written.")
      const planned = plan(material, JSON.parse(material.snapshot) as Frozen)
      if (planned instanceof StepNotResumable) return yield* refuse(planned.message)
      const source = yield* reader.GetVersion({ userId, versionId })
      const rolloutId = uuidv7()
      const added = yield* writer.StartResumedVersion({
        userId,
        versionId,
        forkId,
        expectedRowVersion,
        rolloutId,
        version: {
          speakerEntityId: source.speakerEntityId,
          writer: "model",
          content: planned.continuation ?? "",
          status: "generating",
          macroMode: "verbatim",
          origin: "resumed",
          sourceVersionId: source.id,
          ...(source.direction ? { direction: source.direction } : {})
        },
        transcript: JSON.stringify(planned.transcript),
        steps: countSteps(planned.transcript),
        keptCalls: planned.keptCalls,
        branch: planned.cut.length > 0 ? { reason, messages: JSON.stringify(planned.cut) } : null
      })
      const { chatId, entry } = yield* reader.GetSlot({ userId, slotId: source.slotId, forkId: added.forkId })
      hub.publish(chatId, { _tag: "Slot", entry })
      yield* generations.start({
        userId,
        chatId: added.chatId,
        slotId: source.slotId,
        versionId: added.version.id,
        forkId: added.forkId,
        ...(planned.continuation === undefined ? {} : { initial: { text: planned.continuation, reasoning: "" } }),
        resume: {
          rolloutId,
          snapshot: material.snapshot,
          transcript: planned.transcript,
          ...(planned.continuation === undefined ? {} : { continuation: planned.continuation })
        }
      })
      return entry
    }).pipe(Effect.uninterruptible)

  const registry = yield* ExecutionRegistry
  return {
    GetRolloutSteps: ({ versionId }) =>
      Effect.flatMap(CurrentUser, (user) => reader.RolloutSteps({ userId: user.id, versionId })).pipe(
        internal("GetRolloutSteps")
      ),

    ResumeVersion: ({ versionId, forkId, expectedRowVersion }) =>
      resume(
        versionId,
        forkId ?? null,
        expectedRowVersion,
        (material, frozen) =>
          material.status === "completed"
            ? new StepNotResumable("It finished. Carry on from one of its steps instead.")
            : planResume(material.transcript, { prefill: frozen.inputs?.model?.prefill === "assistant" }),
        "resume"
      ).pipe(internal("ResumeVersion")),

    ResumeFromStep: ({ versionId, step, edit, forkId, expectedRowVersion }) =>
      resume(
        versionId,
        forkId ?? null,
        expectedRowVersion,
        (material, frozen) =>
          planStepResume(material.transcript, frozen.agent?.tools ?? [], step, edit as StepEdit | undefined, uuidv7()),
        "edit"
      ).pipe(internal("ResumeFromStep")),
    GetRunTranscript: ({ versionId }) =>
      Effect.flatMap(CurrentUser, (user) => reader.RolloutTranscript({ userId: user.id, versionId })).pipe(
        internal("GetRunTranscript")
      ),
    // As registered now: a plugin's mode or tool shows here as the built-ins do. External tools
    // are never offered in a reply (spec/AGENTIC.md §4.1), so they aren't listed.
    ListReplyModes: () =>
      Effect.sync(() => {
        const tools = registry.rolloutTools.list().filter((tool) => tool.effect !== "external")
        const registered = new Set(tools.map((tool) => tool.id))
        return {
          modes: registry.orchestrationModes.list().map((mode) => {
            const plan = mode.plan({ state: foldState([]), config: undefined })
            return {
              id: mode.id,
              label: mode.label,
              description: mode.description,
              agentic: plan.strategy !== "reply",
              tools: plan.tools.filter((id) => registered.has(id))
            }
          }),
          tools: tools.map((tool) => ({
            id: tool.id,
            label: tool.label,
            explanation: tool.explanation ?? tool.label,
            effect: tool.effect
          }))
        }
      }),
    ListActivity: ({ chatId, before, limit }) =>
      Effect.flatMap(CurrentUser, (user) =>
        reader.ListActivity({
          userId: user.id,
          chatId,
          limit: limit ?? ACTIVITY_PAGE,
          ...(before === undefined ? {} : { before })
        })
      ).pipe(internal("ListActivity"))
  } satisfies Parameters<typeof AgentApi.of>[0]
})
