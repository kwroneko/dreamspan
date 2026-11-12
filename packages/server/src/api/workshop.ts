import { CurrentUser } from "@rp/shared/api.ts"
import type { ChatId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { type CapabilityMode, GrantRefused, type WorkshopApi } from "@rp/shared/workshopApi.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"
import { ExecutionRegistry, toolForKind } from "../execution.ts"
import { foldState } from "@rp/shared/state.ts"
import { capabilityView } from "../agent/capabilities.ts"
import { cancelCapability, deliverAnswer } from "../agent/approvals.ts"

export const makeWorkshopHandlers = Effect.gen(function* () {
  const writer = yield* Writer
  const reader = yield* Reader
  const execution = yield* ExecutionRegistry
  /** The capabilities of the tools this chat's kind offers, as they stand in it. */
  const capabilitiesOf = (userId: UserId, chatId: ChatId) =>
    Effect.gen(function* () {
      const chat = yield* reader.GetChat({ userId, chatId })
      const profile = execution.chatKinds.get(chat.kind)
      if (!profile?.allowsOutside) return []
      const state = foldState(
        yield* reader.StateEventsAt({ userId, chatId, slotId: chat.activeLeafSlotId, forkId: chat.currentForkId })
      )
      const plan = execution.orchestrationModes.get(profile.planner)?.plan({ state, kind: chat.kind })
      const offered = new Set(
        (plan?.tools ?? []).flatMap((name) => {
          const capability = toolForKind(execution, chat.kind, name)?.capability
          return capability ? [capability] : []
        })
      )
      const grants = new Map<string, CapabilityMode>(
        (yield* reader.WorkshopGrants({ userId, chatId, now: Date.now() })).map((g) => [g.capability, g.mode])
      )
      return execution.workshopCapabilities
        .list()
        .filter((capability) => offered.has(capability.id))
        .sort((a, b) => a.order - b.order)
        .map((capability) => capabilityView(execution, grants, capability))
    })
  return {
    ListWorkshopCapabilities: ({ chatId }) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        return yield* capabilitiesOf(userId, chatId)
      }).pipe(internal("ListWorkshopCapabilities")),
    // Only the user's own request reaches this: no tool is given these operations.
    SetWorkshopGrant: ({ chatId, capability, mode }) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        const offered = (yield* capabilitiesOf(userId, chatId)).find((c) => c.id === capability)
        if (!offered) return yield* new GrantRefused({ message: "This workshop doesn't offer that." })
        if (mode !== null && !offered.modes.includes(mode))
          return yield* new GrantRefused({ message: `“${offered.label}” can't be set that way.` })
        yield* writer.SetWorkshopGrant({ userId, chatId, capability, mode })
        if (mode === "off") cancelCapability(chatId, capability)
        return yield* capabilitiesOf(userId, chatId)
      }).pipe(internal("SetWorkshopGrant")),
    AnswerToolApproval: ({ rolloutId, toolCallId, digest, answer, note }) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        const text = note?.trim() ?? ""
        yield* writer.AnswerToolApproval({
          userId,
          rolloutId,
          toolCallId,
          digest,
          answer,
          note: text === "" ? null : text
        })
        // The waiting call goes on; a run parked by a restart reads the answer when resumed.
        return { waiting: deliverAnswer(rolloutId, toolCallId, answer, text === "" ? null : text) }
      }).pipe(internal("AnswerToolApproval")),
    ListVersionEffects: ({ versionId }) =>
      Effect.flatMap(CurrentUser, (user) => reader.VersionEffects({ userId: user.id, versionId })).pipe(
        internal("ListVersionEffects")
      ),
    ListRolloutEffects: (input) =>
      Effect.flatMap(CurrentUser, (user) => reader.ListRolloutEffects({ ...input, userId: user.id })).pipe(
        internal("ListRolloutEffects")
      ),
    UndoRolloutEffect: (input) =>
      Effect.flatMap(CurrentUser, (user) => writer.UndoRolloutEffect({ ...input, userId: user.id })).pipe(
        internal("UndoRolloutEffect")
      ),
    GetWorkshopDefaults: () =>
      Effect.flatMap(CurrentUser, (user) => reader.WorkshopDefaults({ userId: user.id })).pipe(
        internal("GetWorkshopDefaults")
      ),
    SetWorkshopPersona: ({ persona }) =>
      Effect.flatMap(CurrentUser, (user) => writer.SetWorkshopPersona({ userId: user.id, persona })).pipe(
        internal("SetWorkshopPersona")
      ),
    CreateWorkshop: (input) =>
      Effect.flatMap(CurrentUser, (user) => writer.CreateWorkshop({ ...input, userId: user.id })).pipe(
        internal("CreateWorkshop")
      )
  } satisfies Parameters<typeof WorkshopApi.of>[0]
})
