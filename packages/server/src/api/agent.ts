import { storyReadStamp } from "../agent/continuity.ts"
import { isDeepStrictEqual } from "node:util"
import { outsideEffect } from "../agent/effects.ts"
import type { ConnectionId, ModelId } from "@rp/shared/providers.ts"
type RetryModel = { readonly connection: ConnectionId; readonly model: ModelId }
import type { ContextSnapshot, Generation } from "../assembler/types.ts"
// The agent RPCs (@rp/shared/agentApi.ts). Storage checks the version or chat is the caller's.
import { REPLACEABLE_CARD_FIELDS } from "@rp/shared/docs/note.ts"
import { foldState, permissionKey } from "@rp/shared/state.ts"
import { ACTIVITY_PAGE, NotResumable, type StepEdit } from "@rp/shared/agent.ts"
import { type AgentApi } from "@rp/shared/agentApi.ts"
import { CurrentUser } from "@rp/shared/api.ts"
import type { EntityId, ForkId, StoryAt, VersionId } from "@rp/shared/chat.ts"
import { GenerationUnavailable } from "@rp/shared/chatApi.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect, Option } from "effect"
import { planResume, planStepResume, planMessageResume, type ResumePlan, StepNotResumable } from "../agent/resume.ts"
import { countSteps } from "../agent/steps.ts"
import { notesAt } from "../agent/tools/notes.ts"
import type { FrozenTool } from "../agent/tools.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { Generations } from "../chat/Generations.ts"
import { Generator } from "../chat/Generator.ts"
import { Reader, Writer } from "../db/Database.ts"
import { ExecutionRegistry } from "../execution.ts"
import { internal } from "./internal.ts"

/** What a resume needs of the stopped run's frozen snapshot. */
interface Frozen {
  readonly storyAt?: StoryAt
  readonly storyStamp?: string | null
  readonly inputs?: { readonly model?: { readonly prefill?: string } | null }
  readonly continuity?: { readonly historical?: number }
  readonly agent?: { readonly tools?: ReadonlyArray<FrozenTool>; readonly contract?: string }
}

const agentVersionResumer = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  const generations = yield* Generations
  const generator = yield* Generator
  /**
   * A new version that carries on `versionId`'s run as `plan` keeps it (spec/AGENTIC.md §4.2):
   * written with its rollout in one transaction, then generated from the kept transcript.
   */
  return (
    versionId: VersionId,
    forkId: ForkId | null,
    expectedRowVersion: number,
    plan: (
      material: { readonly status: string; readonly transcript: string | null },
      frozen: Frozen
    ) => ResumePlan | StepNotResumable,
    reason: "resume" | "edit",
    options?: { readonly model?: RetryModel; readonly direction?: string; readonly storyAt?: StoryAt }
  ) =>
    Effect.gen(function* () {
      if (Option.isNone(generator))
        return yield* new GenerationUnavailable({ message: "This server has nothing to generate with." })
      const userId = (yield* CurrentUser).id
      const refuse = (message: string) => Effect.fail(new NotResumable({ versionId, message }))
      const material = yield* reader.RolloutMaterial({ userId, versionId })
      if (!isDeepStrictEqual((JSON.parse(material.snapshot) as Frozen).storyAt, options?.storyAt))
        return yield* refuse(
          "The story position changed. Return to the branch and message this reply read before resuming, or regenerate it to use the position shown now."
        )
      if (
        (JSON.parse(material.snapshot) as Frozen).storyStamp !==
        (yield* storyReadStamp(reader, userId, options?.storyAt))
      )
        return yield* refuse(
          "The story changed since this reply read it. Regenerate it to read the story as it is now."
        )
      if (material.mode === null) return yield* refuse("It wasn't written with tools.")
      if (material.versionStatus === "generating" || material.status === "running")
        return yield* refuse("It's still being written.")
      let planned = plan(material, JSON.parse(material.snapshot) as Frozen)
      if (planned instanceof StepNotResumable) return yield* refuse(planned.message)
      const source = yield* reader.GetVersion({ userId, versionId })
      let snapshot = material.snapshot
      let chosen:
        | {
            connection: import("@rp/shared/providers.ts").ConnectionId
            model: import("@rp/shared/providers.ts").ModelId
          }
        | undefined
      if (options?.model) {
        const assembled = yield* reader
          .AssembleContext({
            userId,
            chatId: (yield* reader.GetSlot({ userId, slotId: source.slotId, forkId })).chatId,
            slotId: source.slotId,
            versionId: source.id,
            forkId,
            now: Date.now(),
            timeZone: "UTC",
            frozen: null,
            model: options.model
          })
          .pipe(
            Effect.catchTag("AssemblyFailed", (error) =>
              Effect.fail(new GenerationUnavailable({ message: error.message }))
            )
          )
        const model = (JSON.parse(assembled.generation) as Generation).model
        if (!model) return yield* new GenerationUnavailable({ message: "The chosen model is unavailable." })
        const frozen = JSON.parse(snapshot) as ContextSnapshot
        snapshot = JSON.stringify({ ...frozen, inputs: { ...frozen.inputs, model } })
        chosen = { connection: model.connectionId as never, model: model.modelId as never }
      }
      if (options?.direction !== undefined)
        planned = {
          ...planned,
          transcript: [
            ...planned.transcript,
            {
              role: "rpHarness",
              content: `Direction for the next message (replaces the earlier direction): ${options.direction.trim() || "None."}`,
              timestamp: Date.now()
            }
          ]
        }
      const rolloutId = uuidv7()
      const added = yield* writer.StartResumedVersion({
        userId,
        versionId,
        forkId,
        expectedRowVersion,
        rolloutId,
        ...(chosen ? { model: chosen, snapshot } : {}),
        version: {
          speakerEntityId: source.speakerEntityId,
          writer: "model",
          content: planned.continuation ?? "",
          status: "generating",
          macroMode: "verbatim",
          origin: "resumed",
          sourceVersionId: source.id,
          ...((options?.direction ?? source.direction) ? { direction: options?.direction ?? source.direction! } : {})
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
        // A side chat's story is read where the tab asking for this showed it (spec/WORKSHOP.md §4).
        ...(options?.storyAt ? { storyAt: options.storyAt } : {}),
        resume: {
          rolloutId,
          snapshot,
          transcript: planned.transcript,
          ...(planned.continuation === undefined ? {} : { continuation: planned.continuation })
        }
      })
      return entry
    }).pipe(Effect.uninterruptible)
})

export const makeAgentHandlers = Effect.gen(function* () {
  const reader = yield* Reader

  const resume = yield* agentVersionResumer

  const registry = yield* ExecutionRegistry
  return {
    GetRolloutSteps: ({ versionId }) =>
      Effect.flatMap(CurrentUser, (user) => reader.RolloutSteps({ userId: user.id, versionId })).pipe(
        internal("GetRolloutSteps")
      ),

    ResumeVersion: ({ versionId, forkId, expectedRowVersion, storyAt }) =>
      resume(
        versionId,
        forkId ?? null,
        expectedRowVersion,
        (material, frozen) =>
          material.status === "completed"
            ? new StepNotResumable("It finished. Carry on from one of its steps instead.")
            : planResume(material.transcript, {
                prefill: frozen.inputs?.model?.prefill === "assistant",
                historical: frozen.continuity?.historical ?? 0
              }),
        "resume",
        storyAt ? { storyAt } : undefined
      ).pipe(internal("ResumeVersion")),

    ResumeFromStep: ({ versionId, step, edit, forkId, expectedRowVersion, storyAt }) =>
      resume(
        versionId,
        forkId ?? null,
        expectedRowVersion,
        (material, frozen) =>
          planStepResume(
            material.transcript,
            frozen.agent?.tools ?? [],
            step,
            edit as StepEdit | undefined,
            uuidv7(),
            versionId,
            frozen.continuity?.historical ?? 0
          ),
        "edit",
        storyAt ? { storyAt } : undefined
      ).pipe(internal("ResumeFromStep")),
    GetRunTranscript: ({ versionId }) =>
      Effect.flatMap(CurrentUser, (user) => reader.RolloutTranscript({ userId: user.id, versionId })).pipe(
        internal("GetRunTranscript")
      ),
    // The rule the note and card tools apply (agent/tools/notes.ts, cardEdit.ts): the chat's
    // `agent.permission`, else the note's `agent_editable` or the card's `agent_editable_fields`.
    GetAgentPermissions: ({ chatId, slotId, forkId }) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        const { notes, state } = yield* notesAt({
          userId,
          chatId,
          forkId: forkId ?? null,
          slotId,
          reader,
          displayEnd: true
        })
        const chosen = (key: string | null, own: boolean) => {
          const choice = key === null ? undefined : state.agentPermissions[key]
          return { on: choice ?? own, own, chosen: choice !== undefined }
        }
        const ids = [...new Set([...state.participants, ...state.playedByMe])] as Array<EntityId>
        const cards = ids.length
          ? yield* reader.AgentCards({
              userId,
              chatId,
              entityIds: ids,
              bindings: Object.fromEntries(
                Object.entries(state.cardBindings).map(([entity, b]) => [
                  entity,
                  { ref: b.ref ?? null, revision: b.revision ?? null }
                ])
              )
            })
          : []
        return {
          notes: notes.map((note) => ({
            entityId: note.entity,
            title: note.title,
            card: note.card,
            linked: note.linked,
            ...chosen(permissionKey({ note: note.entity }), note.doc["agent_editable"] === true)
          })),
          cards: cards.map((card) => ({
            entityId: card.entityId as EntityId,
            name: card.name,
            fields: REPLACEABLE_CARD_FIELDS.map((field) => ({
              field,
              ...chosen(permissionKey({ card: card.entityId, field }), card.editableFields.includes(field))
            }))
          }))
        }
      }).pipe(internal("GetAgentPermissions")),
    // External tools are never offered in an RP reply.
    ListReplyTools: () =>
      Effect.sync(() => {
        const tools = registry.rolloutTools
          .list()
          .filter((tool) => !outsideEffect(tool.effect) && tool.replyTool !== false)
        const registered = new Set(tools.map((tool) => tool.id))
        const plan = registry.orchestrationModes.get("default")?.plan({
          state: foldState([{ scope: null, data: { key: "agent.enabled", value: { on: true } } }]),
          kind: "rp"
        })
        return {
          defaultTools: (plan?.tools ?? []).filter((id) => registered.has(id)),
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

/** Used by the existing Regenerate/swipe action. Other contracts keep fresh generation. */
export const regenerateSeveral = Effect.fnUntraced(function* (input: {
  readonly versionId: VersionId
  readonly forkId: ForkId | null
  readonly expectedRowVersion: number
  readonly model?: RetryModel
  readonly direction?: string
  readonly storyAt?: StoryAt
}) {
  const userId = (yield* CurrentUser).id
  const reader = yield* Reader
  const material = yield* reader.RolloutMaterial({ userId, versionId: input.versionId }).pipe(Effect.option)
  if (material._tag === "None" || (JSON.parse(material.value.snapshot) as Frozen).agent?.contract !== "several")
    return null
  // A new version can assemble afresh at the current position; a retained transcript
  // cannot, because its old tool results may contain another branch or later messages.
  if (!isDeepStrictEqual((JSON.parse(material.value.snapshot) as Frozen).storyAt, input.storyAt)) return null
  if (
    (JSON.parse(material.value.snapshot) as Frozen).storyStamp !==
    (yield* storyReadStamp(reader, userId, input.storyAt))
  )
    return null
  const resume = yield* agentVersionResumer
  return yield* resume(
    input.versionId,
    input.forkId,
    input.expectedRowVersion,
    (stored, frozen) => planMessageResume(stored.transcript, input.versionId, frozen.continuity?.historical ?? 0),
    "edit",
    input
  ).pipe(Effect.catchTag("NotResumable", (error) => Effect.fail(new GenerationUnavailable({ message: error.message }))))
})
