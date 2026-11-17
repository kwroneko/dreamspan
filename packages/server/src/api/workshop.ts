import { PluginHost } from "../plugins/Host.ts"
import { WorkshopFiles } from "../files/WorkshopFiles.ts"
import { FILE_UNDO_ON_HOST } from "../db/workshopEffects.ts"
import { EffectUndoRefused } from "@rp/shared/workshopApi.ts"
import { CurrentUser } from "@rp/shared/api.ts"
import type { ChatId, ForkId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import {
  type CapabilityMode,
  GrantRefused,
  type RolloutEffect,
  type WorkshopApi,
  type WorkshopCapability
} from "@rp/shared/workshopApi.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"
import { ExecutionRegistry, toolForKind } from "../execution.ts"
import { MCP_CAPABILITY } from "../agent/capabilities.ts"
import { mcpHostOf } from "../agent/tools/mcp.ts"
import { foldState } from "@rp/shared/state.ts"
import { capabilityView } from "../agent/capabilities.ts"
import { cancelCapability, deliverAnswer } from "../agent/approvals.ts"
import { CARD_SKILLS } from "../agent/tools/loading.ts"
import { matchPatterns } from "../agent/toolLoading.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { CacheWarmth } from "../chat/CacheWarmth.ts"

export const makeWorkshopHandlers = Effect.gen(function* () {
  const writer = yield* Writer
  const reader = yield* Reader
  const execution = yield* ExecutionRegistry
  const plugins = yield* PluginHost
  const files = yield* WorkshopFiles
  const hub = yield* ChatHub
  const warmth = yield* CacheWarmth
  // Undo runs the recorded worker operation, bypassing the original UI handler's
  // notifications. Publish only after that transaction commits, on its recorded fork.
  // A library entry back or binned (a note, a card) changes what the user's open chats send
  // and list: they read their state again, as after the same change from the library.
  const notifyUndo = (userId: UserId, effects: ReadonlyArray<RolloutEffect>) =>
    Effect.gen(function* () {
      notifyChats(effects)
      if (effects.some((effect) => effect.undoneAt !== null && effect.targetKind === "entity"))
        yield* warmth.refreshUser(userId, true)
    })
  const notifyChats = (effects: ReadonlyArray<RolloutEffect>) => {
    const targets = new Map<string, { chatId: ChatId; forkId?: ForkId; state: boolean; history: boolean }>()
    for (const effect of effects) {
      if (effect.undoneAt === null || effect.targetKind !== "chat") continue
      const recipe = effect.undo
      const operation = recipe?.operation
      const state = operation === "AddStateEvent" || operation === "AddStateEvents"
      const history = typeof recipe?.changesetId === "string" || (effect.kind === "chat.change" && !state)
      if (!state && !history) continue
      const input = recipe?.input as { forkId?: unknown } | undefined
      const prior = recipe?.prior as { chat?: { current_fork_id?: unknown } } | undefined
      const fork = input?.forkId ?? recipe?.forkId ?? prior?.chat?.current_fork_id
      const forkId = typeof fork === "string" ? (fork as ForkId) : undefined
      const chatId = effect.targetId as ChatId
      const key = JSON.stringify([chatId, forkId])
      const target = targets.get(key) ?? { chatId, ...(forkId ? { forkId } : {}), state: false, history: false }
      target.state ||= state
      target.history ||= history
      targets.set(key, target)
    }
    for (const { chatId, forkId, state, history } of targets.values()) {
      const scope = forkId ? { forkId } : {}
      if (state) hub.publish(chatId, { _tag: "State", ...scope })
      if (history) {
        hub.publish(chatId, { _tag: "Reload", ...scope })
        hub.publish(chatId, { _tag: "Lcm", ...scope })
      }
    }
  }
  const undo = (
    actor: import("@rp/shared/domain.ts").User,
    input: { rolloutId: string; toolCallId: string; seq: number }
  ) =>
    writer.UndoRolloutEffect({ ...input, userId: actor.id }).pipe(
      Effect.catchTag("EffectUndoRefused", (error) => {
        // A file the agent wrote is on disk: the files host puts it back and records the undo.
        if (error.message === FILE_UNDO_ON_HOST)
          return Effect.gen(function* () {
            const effect = yield* reader.RolloutEffectFor({ ...input, userId: actor.id })
            return yield* files
              .undoEffect(actor, effect)
              .pipe(
                Effect.mapError((cause) =>
                  cause instanceof EffectUndoRefused
                    ? cause
                    : new EffectUndoRefused({ message: "The file couldn't be put back. Open its versions." })
                )
              )
          })
        if (error.message !== "Plugin file undo must run through the host.") return Effect.fail(error)
        return Effect.gen(function* () {
          const effect = yield* reader.RolloutEffectFor({ ...input, userId: actor.id })
          return yield* plugins.undoEffect(actor, effect).pipe(
            Effect.mapError(
              () =>
                new EffectUndoRefused({
                  message:
                    "This plugin has changed since this edit. Undo its newer edits first, or open Settings → Plugins to review its versions."
                })
            )
          )
        })
      }),
      Effect.tap((effect) => notifyUndo(actor.id, [effect]))
    )
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
      // A kind that loads some of its tools as it goes may load a card's skills (spec/TOOL-LOADING.md §6).
      // A setting shown with the capability it belongs to (Internet from commands, with Run commands).
      for (const entry of execution.workshopCapabilities.list())
        if (entry.alongside && offered.has(entry.alongside)) offered.add(entry.id)
      const loading = execution.toolLoadingProfiles.get(chat.kind)
      const planned = plan?.tools ?? []
      if (loading && matchPatterns(planned, loading.immediate).length < planned.length) offered.add(CARD_SKILLS)
      const grants = new Map<string, CapabilityMode>(
        (yield* reader.WorkshopGrants({ userId, chatId, now: Date.now() })).map((g) => [g.capability, g.mode])
      )
      const story =
        state.workshopAttached === undefined
          ? null
          : yield* reader
              .GetChat({
                userId,
                chatId: state.workshopAttached as ChatId
              })
              .pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)))
      // One row per MCP server the user can use (spec/MCP.md §13.3), after the built-ins, in
      // creation order: On or Off here, else the server's Workshops switch.
      const mcpEntry = execution.workshopCapabilities.get(MCP_CAPABILITY)
      const servers = mcpEntry
        ? (yield* reader.McpWorkshopConnections({ userId, chatId })).map(
            ({ connection, grant }, index): WorkshopCapability => {
              const host = mcpHostOf(connection)
              const defaultMode = connection.use.workshops ? "allow" : "off"
              const chosen = grant === "allow" || grant === "off"
              return {
                id: MCP_CAPABILITY,
                target: connection.id,
                order: mcpEntry.order + index,
                label: connection.name,
                explanation: `Uses ${connection.name}'s tools. Each call sends what the assistant writes in it to ${host}.`,
                mode: chosen ? grant : defaultMode,
                defaultMode,
                modes: ["off", "allow"],
                chosen
              }
            }
          )
        : []
      // Commands without a sandbox here: the row says why and how to fix it (spec §3.3).
      const noCommands = offered.has("commands") ? yield* files.commandsUnavailable() : null
      const builtins = execution.workshopCapabilities
        .list()
        .filter((capability) => offered.has(capability.id) && capability.id !== MCP_CAPABILITY)
        .sort((a, b) => a.order - b.order)
        .map((capability) =>
          capabilityView(
            execution,
            grants,
            capability.id === "chats.read" && state.workshopAttached !== undefined
              ? {
                  ...capability,
                  label: "Read this story",
                  explanation: `Reads only “${story?.title?.trim() || "Unavailable story"}” in this workshop. Its messages go to this workshop's model.`,
                  example: "Reads the story's last ten messages to sum it up."
                }
              : capability.id === "commands" && noCommands
                ? { ...capability, explanation: `${capability.explanation} Not available here: ${noCommands}` }
                : capability
          )
        )
      return [...builtins, ...servers]
    })
  return {
    ListWorkshopCapabilities: ({ chatId }) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        return yield* capabilitiesOf(userId, chatId)
      }).pipe(internal("ListWorkshopCapabilities")),
    // Only the user's own request reaches this: no tool is given these operations.
    SetWorkshopGrant: ({ chatId, capability, mode, target }) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        const offered = (yield* capabilitiesOf(userId, chatId)).find(
          (c) => c.id === capability && (c.target ?? "") === (target ?? "")
        )
        if (!offered) return yield* new GrantRefused({ message: "This workshop doesn't offer that." })
        if (mode !== null && !offered.modes.includes(mode))
          return yield* new GrantRefused({ message: `“${offered.label}” can't be set that way.` })
        yield* writer.SetWorkshopGrant({ userId, chatId, capability, mode, ...(target ? { target } : {}) })
        if (mode === "off") cancelCapability(chatId, capability, target)
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
      Effect.flatMap(CurrentUser, (user) => undo(user, input)).pipe(internal("UndoRolloutEffect")),
    UndoRolloutEffects: (input) =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.gen(function* () {
          const all = yield* reader.RolloutEffectsForRun({
            userId: user.id,
            chatId: input.chatId,
            rolloutId: input.rolloutId
          })
          const rows = all.filter((e) => e.rolloutId === input.rolloutId && e.undoneAt === null)
          if (!rows.some((e) => e.kind.startsWith("plugin."))) {
            const result = yield* writer.UndoRolloutEffects({ ...input, userId: user.id })
            yield* notifyUndo(user.id, result.undone)
            return result
          }
          const undone: Array<(typeof rows)[number]> = []
          for (const [at, row] of rows.entries()) {
            const result = yield* undo(user, row).pipe(Effect.exit)
            if (result._tag === "Failure")
              return {
                undone,
                refused: { effect: row, reason: "This change couldn't be undone. Undo newer changes first." },
                left: rows.slice(at + 1)
              }
            undone.push(result.value)
          }
          return { undone, refused: null, left: [] }
        })
      ).pipe(internal("UndoRolloutEffects")),
    ListAttachedWorkshops: ({ chatId, forkId }) =>
      Effect.flatMap(CurrentUser, (user) =>
        reader.AttachedWorkshops({ userId: user.id, chatId, ...(forkId ? { forkId } : {}) })
      ).pipe(internal("ListAttachedWorkshops")),
    ListWorkshopBranches: ({ chatId }) =>
      Effect.flatMap(CurrentUser, (user) => reader.WorkshopBranches({ userId: user.id, chatId })).pipe(
        internal("ListWorkshopBranches")
      ),
    ListWorkshopStories: ({ chatIds }) =>
      Effect.flatMap(CurrentUser, (user) => reader.WorkshopStories({ userId: user.id, chatIds })).pipe(
        internal("ListWorkshopStories")
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
