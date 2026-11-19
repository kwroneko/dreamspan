import { ProviderRegistry } from "../providers/registry.ts"
import { CALL_TOOL, dispatcherDefinition } from "../agent/dispatcher.ts"
import { serverStoryAt, storyReadStamp } from "../agent/continuity.ts"
import { loadingWireFor } from "../agent/loadingPlan.ts"
import { loadedSet } from "../agent/toolLoading.ts"
import { isDeepStrictEqual } from "node:util"
import { outsideEffect } from "../agent/effects.ts"
import type { ConnectionId, ModelId } from "@dreamspan/shared/providers.ts"
type RetryModel = { readonly connection: ConnectionId; readonly model: ModelId }
import type { AssembledRequest, ContextSnapshot, ModelInput } from "../assembler/types.ts"
import type { ContextBudget } from "@dreamspan/shared/inspectorApi.ts"
// The agent RPCs (@dreamspan/shared/agentApi.ts). Storage checks the version or chat is the caller's.
import { REPLACEABLE_CARD_FIELDS } from "@dreamspan/shared/docs/note.ts"
import { type ChatState, foldState, permissionKey } from "@dreamspan/shared/state.ts"
import { ACTIVITY_PAGE, NotResumable, type StepEdit } from "@dreamspan/shared/agent.ts"
import { type AgentApi } from "@dreamspan/shared/agentApi.ts"
import { CurrentUser } from "@dreamspan/shared/api.ts"
import type { ChatId, EntityId, ForkId, StoryAt, VersionId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { GenerationUnavailable } from "@dreamspan/shared/chatApi.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { Effect, Option } from "effect"
import {
  planResume,
  planStepResume,
  planMessageResume,
  type ResumePlan,
  StepNotResumable,
  withoutThinking
} from "../agent/resume.ts"
import { countSteps } from "../agent/steps.ts"
import { notesAt } from "../agent/tools/notes.ts"
import {
  type FrozenTool,
  frozenTool,
  noReplyDefinition,
  sendMessageDefinition,
  severalMessageDefinition
} from "../agent/tools.ts"
import { offeredByGrants } from "../agent/approvals.ts"
import { planTurn } from "../agent/modes.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { Generations } from "../chat/Generations.ts"
import { shownModel } from "../chat/shownModel.ts"
import { Generator } from "../chat/Generator.ts"
import { Reader, Writer } from "../db/Database.ts"
import { ExecutionRegistry, toolForKind } from "../execution.ts"
import { internal } from "./internal.ts"
import { mayUse, stopSubagent, typesFor } from "../agent/subagents.ts"
import { checkTypeEdit, subagentToolCatalog as toolCatalog } from "../agent/subagentTypeEdits.ts"
import { rowProblems, SAME, SubagentSettingsRejected, type SubagentTypeEdit } from "@dreamspan/shared/subagents.ts"

/** What a resume needs of the stopped run's frozen snapshot. */
interface Frozen {
  readonly storyAt?: StoryAt
  readonly storyStamp?: string | null
  readonly inputs?: { readonly model?: { readonly prefill?: string } | null }
  readonly continuity?: { readonly historical?: number }
  readonly agent?: { readonly tools?: ReadonlyArray<FrozenTool>; readonly contract?: string }
}

/**
 * The stopped run's frozen request, rebuilt for the model the chat uses now (spec/AGENTIC.md
 * §12.3): the same messages and transcript, so the model is still sent what the run had
 * written, with the new model's own parameters and cache layout. The previous turn's carried
 * cache checkpoints index the old model's wire, so they go.
 */
const forModel = (
  snapshot: ContextSnapshot,
  now: { readonly model: ModelInput; readonly samplers: AssembledRequest["samplers"]; readonly budget?: ContextBudget }
): ContextSnapshot => {
  const continuity = (snapshot as { readonly continuity?: Record<string, unknown> }).continuity
  return {
    ...snapshot,
    inputs: { ...snapshot.inputs, model: now.model },
    request: { ...snapshot.request, samplers: now.samplers },
    ...(now.budget ? { contextBudget: now.budget } : {}),
    ...(continuity
      ? {
          continuity: {
            ...continuity,
            parent: undefined,
            breakpoints: [],
            reason:
              "The model changed. If its tool list changes, the next request reads the chat again once at full input cost."
          }
        }
      : {})
  } as ContextSnapshot
}

const agentVersionResumer = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  const generations = yield* Generations
  const generator = yield* Generator
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry)
  const execution = yield* ExecutionRegistry
  /**
   * The tools the chat offers now (spec/AGENTIC.md §12.4), or undefined when that's what the run
   * froze. Only a change of the chat's settings since the run counts: the planner sees the state
   * before the reply (as the run did) and the state now, and what it adds or removes between the
   * two is added to or removed from the frozen offer. A planner or tool replaced since then
   * (code, not the user's settings) leaves the run's offer as it was. A tool kept keeps its frozen
   * definition; the output contract's tool stays.
   */
  const toolsNow = (at: {
    readonly userId: UserId
    readonly chatId: ChatId
    readonly then: ChatState
    readonly now: ChatState
    readonly frozen: ReadonlyArray<FrozenTool>
  }) =>
    Effect.gen(function* () {
      const chat = yield* reader.GetChat({ userId: at.userId, chatId: at.chatId })
      const profile = execution.chatKinds.get(chat.kind)
      if (!profile) return undefined
      const before = planTurn(execution.orchestrationModes, at.then, chat.kind, profile.planner)
      const after = planTurn(execution.orchestrationModes, at.now, chat.kind, profile.planner)
      if ("unavailable" in before || "unavailable" in after) return undefined
      const removed = new Set(before.plan.tools.filter((id) => !after.plan.tools.includes(id)))
      const candidates = after.plan.tools.flatMap((id) => {
        if (before.plan.tools.includes(id) || at.frozen.some((t) => t.name === id)) return []
        const tool = toolForKind(execution, chat.kind, id)
        return tool && (profile.allowsOutside || !outsideEffect(tool.effect)) ? [tool] : []
      })
      // A tool new to the run is offered only as a new run would offer it; one the run was offered
      // stays even if its capability was turned off, and is refused when called, as it is mid-run
      // (spec/WORKSHOP.md §3.4), so the model is told why.
      const { tools: added } = yield* offeredByGrants(
        { registries: execution, reader, userId: at.userId, chatId: at.chatId },
        candidates
      )
      const contract = new Set([sendMessageDefinition.name, severalMessageDefinition.name, noReplyDefinition.name])
      const kept = at.frozen.filter((t) => !contract.has(t.name) && !removed.has(t.name))
      const now = [...kept, ...added.map(frozenTool), ...at.frozen.filter((t) => contract.has(t.name))]
      return isDeepStrictEqual(
        now.map((t) => t.name),
        at.frozen.map((t) => t.name)
      )
        ? undefined
        : now
    })
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
      frozen: Frozen,
      /** The model the run goes on with: the chat's now (spec/AGENTIC.md §12.3). */
      model: ModelInput
    ) => ResumePlan | StepNotResumable,
    reason: "resume" | "edit",
    options?: {
      readonly model?: RetryModel
      readonly direction?: string
      readonly saved?: boolean
    }
  ) =>
    Effect.gen(function* () {
      if (Option.isNone(generator))
        return yield* new GenerationUnavailable({ message: "This server has nothing to generate with." })
      const userId = (yield* CurrentUser).id
      const refuse = (message: string) => Effect.fail(new NotResumable({ versionId, message }))
      const material = yield* reader.RolloutMaterial({ userId, versionId })
      // A workshop beside a story reads its paired branch where it stands now (WORKSHOP-BRANCHES §2.2).
      const located = yield* reader.GetVersion({ userId, versionId })
      const storyAt = yield* serverStoryAt(
        reader,
        userId,
        (yield* reader.GetSlot({ userId, slotId: located.slotId, forkId })).chatId,
        forkId
      )
      if (!isDeepStrictEqual((JSON.parse(material.snapshot) as Frozen).storyAt, storyAt))
        return yield* refuse(
          "The story position changed. Return to the branch and message this reply read before resuming, or regenerate it to use the position shown now."
        )
      if ((JSON.parse(material.snapshot) as Frozen).storyStamp !== (yield* storyReadStamp(reader, userId, storyAt)))
        return yield* refuse(
          "The story changed since this reply read it. Regenerate it to read the story as it is now."
        )
      if (material.mode === null) return yield* refuse("It wasn't written with tools.")
      if (material.versionStatus === "generating" || material.status === "running")
        return yield* refuse("It's still being written.")
      const source = yield* reader.GetVersion({ userId, versionId })
      const sourceSlot = yield* reader.GetSlot({ userId, slotId: source.slotId, forkId })
      const chatId = sourceSlot.chatId
      const chat = yield* reader.GetChat({ userId, chatId })
      const frozen = JSON.parse(material.snapshot) as ContextSnapshot
      const frozenAgent = (frozen as Frozen).agent
      let planned: ResumePlan | StepNotResumable
      let snapshot = material.snapshot
      let chosen: RetryModel | undefined
      let checkBudget = false
      if (options?.saved) {
        // The stored request as it was, with its model and tools: only on the user's word.
        const model = frozen.inputs.model
        if (!model) return yield* refuse("Its saved request names no model.")
        planned = plan(material, frozen as Frozen, model)
      } else {
        // The chat's settings as they are now decide the model and the tools: the model "Retry
        // with…" names, or the one the composer shows under this reply, which takes a choice
        // made after it stopped (spec/AGENTIC.md §12.3). The assembly alone reads the state
        // before the reply.
        const events = yield* reader.StateEventsAt({ userId, chatId, slotId: source.slotId, forkId, displayEnd: true })
        const state = foldState(events)
        const shown = options?.model ?? (yield* shownModel(reader, { userId, chatId, slotId: source.slotId, forkId }))
        if (!shown) return yield* refuse("No model is chosen for this chat. Choose one, then resume.")
        const failed = yield* reader
          .AssembleContext({
            userId,
            chatId,
            slotId: source.slotId,
            versionId: source.id,
            forkId,
            now: Date.now(),
            timeZone: "UTC",
            frozen: null,
            ...(shown ? { model: shown } : {})
          })
          .pipe(
            Effect.map((assembled) => ({ assembled })),
            Effect.catchTag("AssemblyFailed", (error) => Effect.succeed({ failure: error.message }))
          )
        // Never sent silently: the user is told, and may send the saved request instead.
        if ("failure" in failed)
          return yield* new NotResumable({
            versionId,
            message: `Its request can't be built from the chat as it is now: ${failed.failure}`,
            savedRequest: true
          })
        const fresh = JSON.parse(failed.assembled.snapshot) as ContextSnapshot
        const model = fresh.inputs.model
        if (!model)
          return yield* refuse(
            options?.model
              ? "The chosen model is unavailable."
              : "No model is chosen for this chat. Choose one, then resume."
          )
        planned = plan(material, frozen as Frozen, model)
        // The same model (connection and model, the connection unedited) sends the frozen request
        // byte for byte, so the provider's cache still holds, the model's settings edited since
        // included: its samplers and its provider route, which the run's tool loading froze with
        // it (spec/TOOL-LOADING.md §10). Another model takes its own settings (spec/AGENTIC.md §12.3).
        const modelChanged =
          frozen.inputs.model?.connectionId !== model.connectionId ||
          frozen.inputs.model?.modelId !== model.modelId ||
          frozen.inputs.model?.connectionRevision !== model.connectionRevision
        checkBudget = modelChanged
        let rebuilt: ContextSnapshot = modelChanged
          ? forModel(frozen, {
              model,
              samplers: fresh.request.samplers,
              ...(fresh.contextBudget ? { budget: fresh.contextBudget } : {})
            })
          : frozen
        const tools = frozenAgent?.tools
          ? yield* toolsNow({
              userId,
              chatId,
              then: foldState(
                yield* reader.StateEventsAt({ userId, chatId, slotId: sourceSlot.entry.parentSlotId, forkId })
              ),
              now: state,
              frozen: frozenAgent.tools
            })
          : undefined
        if (tools) rebuilt = { ...rebuilt, agent: { ...frozenAgent, tools } } as ContextSnapshot
        if (modelChanged && frozenAgent?.tools) {
          const real = ((rebuilt as Frozen).agent?.tools ?? []).filter((t) => t.name !== CALL_TOOL)
          const dispatcher = loadingWireFor(execution, model)?.dispatcher && real.some((t) => t.deferred)
          const transport = frozenAgent.tools.find((t) => t.name === CALL_TOOL)
          rebuilt = {
            ...rebuilt,
            agent: {
              ...(rebuilt as Frozen).agent,
              tools: [
                ...real,
                ...(dispatcher
                  ? [transport ?? { ...dispatcherDefinition, label: "Called a loaded tool", effect: "read" }]
                  : [])
              ]
            }
          } as ContextSnapshot
        }
        if (modelChanged || tools) snapshot = JSON.stringify(rebuilt)
        if (modelChanged) chosen = { connection: model.connectionId as ConnectionId, model: model.modelId as ModelId }
      }
      if (planned instanceof StepNotResumable) return yield* refuse(planned.message)
      // Only the user's thinking choices override a saved request. Its other pinned text,
      // settings and tool receipts remain as they were, including "send the saved request".
      const thinkingForkId = sourceSlot.entry.shownForkId
      if (thinkingForkId) {
        const updated = yield* reader
          .RebuildContext({ userId, snapshot, thinkingForkId })
          .pipe(Effect.catchTag("AssemblyFailed", (error) => refuse(error.message)))
        if (updated._tag === "Rebuilt") snapshot = updated.snapshot
      }
      // Reasoning the user hid on this reply isn't sent again by the run that carries it on.
      if ((yield* reader.GetThinkingHidden({ userId, versionId, forkId })).includes("reasoning")) {
        const model = (JSON.parse(snapshot) as ContextSnapshot).inputs.model
        const binding =
          model && Option.isSome(providerRegistry)
            ? providerRegistry.value.thinkingBindings
                .list()
                .find((b) => b.appliesTo({ kind: model.kind, api: model.api, model: model.key }))
            : undefined
        planned = {
          ...planned,
          transcript: withoutThinking(
            planned.transcript,
            (frozen as Frozen).continuity?.historical ?? 0,
            !!model && !!binding?.deferHiddenThinking?.(model.key)
          )
        }
      }
      if (options?.direction !== undefined)
        planned = {
          ...planned,
          transcript: [
            ...planned.transcript,
            {
              role: "rpApp",
              content: `Direction for the next message (replaces the earlier direction): ${options.direction.trim() || "None."}`,
              timestamp: Date.now()
            }
          ]
        }
      // Assembly sizes today's chat, not the frozen prefix and kept tool results. Check the
      // actual carried run before creating a version or executing any dangling effect.
      const resumedSnapshot = JSON.parse(snapshot) as ContextSnapshot & Frozen
      const budget = resumedSnapshot.contextBudget
      if (checkBudget && budget && resumedSnapshot.inputs.model) {
        // The tools as the resumed request sends them (agent/session.ts): on a model whose wire
        // API defers tools, one not loaded in the kept transcript takes no room yet.
        const offered = resumedSnapshot.agent?.tools ?? []
        const deferred = new Set(
          loadingWireFor(execution, resumedSnapshot.inputs.model)
            ? offered.filter((t) => t.deferred === true).map((t) => t.name)
            : []
        )
        const loaded = loadedSet(planned.transcript, deferred)
        const count = yield* reader.CountRolloutContext({
          model: JSON.stringify(resumedSnapshot.inputs.model),
          request: JSON.stringify(resumedSnapshot.request),
          transcript: JSON.stringify(planned.transcript),
          tools: JSON.stringify(
            offered.some((t) => t.name === CALL_TOOL)
              ? offered
              : offered.filter((t) => !deferred.has(t.name) || loaded.has(t.name))
          ),
          ...(planned.continuation === undefined ? {} : { continuation: planned.continuation })
        })
        if (count > budget.maximum - budget.responseReserve && !execution.chatKinds.get(chat.kind)?.summaryTranscript)
          return yield* refuse(
            "The saved run is too large for this model's context window. Choose a model with more room, then resume."
          )
      }
      const rolloutId = uuidv7()
      const added = yield* writer.StartResumedVersion({
        userId,
        versionId,
        forkId,
        expectedRowVersion,
        rolloutId,
        ...(chosen ? { model: chosen } : {}),
        ...(snapshot === material.snapshot ? {} : { snapshot }),
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
      const { entry } = yield* reader.GetSlot({ userId, slotId: source.slotId, forkId: added.forkId })
      hub.publish(chatId, { _tag: "Slot", entry })
      yield* generations.start({
        userId,
        chatId: added.chatId,
        slotId: source.slotId,
        versionId: added.version.id,
        forkId: added.forkId,
        ...(planned.continuation === undefined ? {} : { initial: { text: planned.continuation, reasoning: "" } }),
        ...(storyAt ? { storyAt } : {}),
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
  const writer = yield* Writer

  const resume = yield* agentVersionResumer

  const registry = yield* ExecutionRegistry
  /** The tools a subagent type may be given (§10): what a workshop offers, less what no subagent gets. */
  const subagentToolCatalog = () => toolCatalog(registry)
  return {
    GetRolloutSteps: ({ versionId }) =>
      Effect.flatMap(CurrentUser, (user) => reader.RolloutSteps({ userId: user.id, versionId })).pipe(
        internal("GetRolloutSteps")
      ),

    ResumeVersion: ({ versionId, forkId, expectedRowVersion, saved }) =>
      resume(
        versionId,
        forkId ?? null,
        expectedRowVersion,
        (material, frozen, model) =>
          material.status === "completed"
            ? new StepNotResumable("It finished. Carry on from one of its steps instead.")
            : planResume(material.transcript, {
                // Text cut off goes on only where the model it goes on with takes a prefill, and
                // where text may be the reply: under the send tool alone it never is, so the turn
                // is written again with its tools (spec/REPLY-CONTRACT.md §3.2, §3.4).
                prefill: model.prefill === "assistant" && frozen.agent?.contract !== "send_message",
                historical: frozen.continuity?.historical ?? 0
              }),
        "resume",
        saved ? { saved: true } : undefined
      ).pipe(internal("ResumeVersion")),

    ResumeFromStep: ({ versionId, step, edit, forkId, expectedRowVersion }) =>
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
        "edit"
      ).pipe(internal("ResumeFromStep")),
    GetRunTranscript: ({ versionId }) =>
      Effect.flatMap(CurrentUser, (user) => reader.RolloutTranscript({ userId: user.id, versionId })).pipe(
        internal("GetRunTranscript")
      ),
    GetModelBehaviour: () =>
      Effect.flatMap(CurrentUser, (user) => reader.ModelBehaviour({ userId: user.id })).pipe(
        internal("GetModelBehaviour")
      ),
    // A subagent's own run, through the reply it belongs to (spec/SUBAGENTS.md §7).
    GetSubagentRun: ({ versionId, rolloutId }) =>
      Effect.flatMap(CurrentUser, (user) => reader.SubagentRun({ userId: user.id, versionId, rolloutId })).pipe(
        internal("GetSubagentRun")
      ),
    // Its row's Stop: only a subagent of this reply's run, and only that one (spec/SUBAGENTS.md §8).
    StopSubagent: ({ versionId, rolloutId }) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        yield* reader.SubagentStatus({ userId, versionId, rolloutId })
        return { stopped: stopSubagent(userId, rolloutId) }
      }).pipe(internal("StopSubagent")),
    // The account's subagent models and limits (spec/SUBAGENTS.md §5.1, §6.2): the user's alone.
    GetSubagentSettings: () =>
      Effect.flatMap(CurrentUser, (user) => reader.SubagentSettings({ userId: user.id })).pipe(
        internal("GetSubagentSettings")
      ),
    ChangeSubagentSettings: ({ picks, rows, limits }) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        if (rows !== undefined) {
          const current = yield* reader.SubagentSettings({ userId })
          const problems = rowProblems({ ...current.models.rows, ...rows, [SAME]: { alias: "same", note: "" } })
          if (problems.length) return yield* new SubagentSettingsRejected({ message: problems.join(" ") })
        }
        yield* writer.ChangeSubagentSettings({
          userId,
          ...(picks === undefined ? {} : { picks: [...new Set(picks)] }),
          ...(rows === undefined ? {} : { rows }),
          ...(limits === undefined ? {} : { limits })
        })
      }).pipe(internal("ChangeSubagentSettings")),
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
    // The subagent types as they apply to the user (spec/SUBAGENTS.md §10), and the tools a type may get.
    GetSubagentTypes: () =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const settings = yield* reader.SubagentSettings({ userId: user.id })
        const catalog = subagentToolCatalog()
        return {
          types: typesFor(registry.subagentTypes.list(), settings.types)
            .filter((t) => t.kinds.includes("workshop"))
            .map((t) => ({
              id: t.id,
              label: t.label,
              explanation: t.explanation ?? "",
              description: t.description,
              instructions: t.instructions,
              tools: catalog.filter((tool) => mayUse(t, tool)).map((tool) => tool.id),
              defaultAlias: t.defaultAlias,
              context: t.context ?? "task",
              isolation: t.isolation ?? ("none" as const),
              source: t.source,
              edited: t.edited,
              off: t.off
            })),
          tools: catalog.map((tool) => ({
            id: tool.id,
            label: tool.label,
            explanation: tool.explanation ?? tool.label,
            effect: tool.effect
          }))
        }
      }).pipe(internal("GetSubagentTypes")),
    ChangeSubagentType: ({ id, edit }) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        const current = (yield* reader.SubagentSettings({ userId })).types
        const rest = current.filter((e) => e.id !== id)
        let stored: SubagentTypeEdit | null = null
        if (edit !== null) {
          const reject = (message: string) => new SubagentSettingsRejected({ message })
          if (edit.id !== id) return yield* reject("A type keeps its id.")
          const checked = checkTypeEdit(registry.subagentTypes.list(), subagentToolCatalog(), edit)
          if ("rejected" in checked) return yield* reject(checked.rejected)
          stored = checked.stored
          if (stored && !registry.subagentTypes.get(id) && !current.some((e) => e.id === id) && rest.length >= 32)
            return yield* reject("You have as many subagent types as you may.")
        }
        const at = current.findIndex((e) => e.id === id)
        const types =
          stored === null ? rest : at < 0 ? [...current, stored] : current.map((e, i) => (i === at ? stored : e))
        yield* writer.ChangeSubagentSettings({ userId, types })
      }).pipe(internal("ChangeSubagentType")),
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
            effect: tool.effect,
            ...(tool.subagents ? { subagents: true } : {})
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
}) {
  const userId = (yield* CurrentUser).id
  const reader = yield* Reader
  const material = yield* reader.RolloutMaterial({ userId, versionId: input.versionId }).pipe(Effect.option)
  if (material._tag === "None" || (JSON.parse(material.value.snapshot) as Frozen).agent?.contract !== "several")
    return null
  const located = yield* reader.GetVersion({ userId, versionId: input.versionId })
  const storyAt = yield* serverStoryAt(
    reader,
    userId,
    (yield* reader.GetSlot({ userId, slotId: located.slotId, forkId: input.forkId })).chatId,
    input.forkId
  )
  // A new version can assemble afresh at the current position; a retained transcript
  // cannot, because its old tool results may contain another branch or later messages.
  if (!isDeepStrictEqual((JSON.parse(material.value.snapshot) as Frozen).storyAt, storyAt)) return null
  if ((JSON.parse(material.value.snapshot) as Frozen).storyStamp !== (yield* storyReadStamp(reader, userId, storyAt)))
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
