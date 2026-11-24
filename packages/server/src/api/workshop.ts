import { PluginHost } from "../plugins/Host.ts"
import { WorkshopFiles } from "../files/WorkshopFiles.ts"
import { HostFolderRefusal } from "../files/hostFolders.ts"
import { FILES_TOP } from "@dreamspan/shared/files.ts"
import { FILE_UNDO_ON_HOST } from "../db/workshopEffects.ts"
import { changedUnits, docOfUnits } from "@dreamspan/shared/changeReversal.ts"
import type { User } from "@dreamspan/shared/domain.ts"
import { EffectUndoRefused, HostFolderRefused } from "@dreamspan/shared/workshopApi.ts"
import { CurrentUser } from "@dreamspan/shared/api.ts"
import type { ChatId, ForkId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import {
  type CapabilityMode,
  GrantRefused,
  type RolloutEffect,
  type WorkshopApi,
  type WorkshopCapability,
  type WorkshopGrantChoice
} from "@dreamspan/shared/workshopApi.ts"
import { Effect, Option } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"
import { ExecutionRegistry, toolForKind } from "../execution.ts"
import { COMMANDS_UNSANDBOXED, consentTarget, MCP_CAPABILITY } from "../agent/capabilities.ts"
import { mcpHostOf } from "../agent/tools/mcp.ts"
import { type ChatState, foldState } from "@dreamspan/shared/state.ts"
import { capabilityView, SIDE_STORY_READ_MODE } from "../agent/capabilities.ts"
import { chatKinds } from "@dreamspan/shared/chatKinds.ts"
import { Forbidden, NotFound } from "@dreamspan/shared/errors.ts"
import type { McpConnection } from "@dreamspan/shared/mcp.ts"
import { cancelCapability, deliverAnswer } from "../agent/approvals.ts"
import { CARD_SKILLS } from "../agent/tools/loading.ts"
import { matchPatterns } from "../agent/toolLoading.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { Generations } from "../chat/Generations.ts"
import { Generator } from "../chat/Generator.ts"
import { GenerationUnavailable } from "@dreamspan/shared/chatApi.ts"

/** The kind a workshop is made as (db/workshopWrites.ts). */
const WORKSHOP_KIND = "workshop"

export const makeWorkshopHandlers = Effect.gen(function* () {
  const writer = yield* Writer
  const reader = yield* Reader
  const execution = yield* ExecutionRegistry
  const plugins = yield* PluginHost
  const files = yield* WorkshopFiles
  const hub = yield* ChatHub
  const warmth = yield* CacheWarmth
  const generator = yield* Generator
  const generations = yield* Generations
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
    actor: import("@dreamspan/shared/domain.ts").User,
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
  /** A card file edit's fields before and after (`undo.card` of `edit_card_file`), or null. */
  const cardEdit = (effect: RolloutEffect) => {
    const card = effect.undo?.card as { before?: unknown; after?: unknown; name?: unknown } | undefined
    return effect.kind === "file.edit" && card && typeof card.before === "object" && typeof card.after === "object"
      ? {
          name: typeof card.name === "string" ? card.name : "",
          before: card.before as Record<string, unknown>,
          after: card.after as Record<string, unknown>
        }
      : null
  }
  const keyOf = (e: { rolloutId: string; toolCallId: string; seq: number }) => ({
    rolloutId: e.rolloutId,
    toolCallId: e.toolCallId,
    seq: e.seq
  })
  type ReversalInput = {
    readonly fields?: ReadonlyArray<string>
    readonly choices?: Readonly<Record<string, "now" | "before">>
    readonly dryRun?: boolean
    readonly message?: string
  }
  /** A card file's revert failed on the host: its refusal, else a plain one. */
  const onHost = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause instanceof EffectUndoRefused || cause instanceof NotFound
          ? cause
          : new EffectUndoRefused({ message: "The card file couldn't be changed. Open its versions." })
      )
    )
  /** A revert or redo changed a library item: what open chats send may change, as after an undo. */
  const notifyReverted = (userId: UserId) => warmth.refreshUser(userId, true)
  /**
   * Reverts one item's changes (spec/WORKSHOP-CARDS.md §8.1): a library item's in the writer, a
   * card file's on the files host, which records it after writing the file.
   */
  const revert = (
    actor: User,
    keys: ReadonlyArray<{ rolloutId: string; toolCallId: string; seq: number }>,
    options: ReversalInput
  ) =>
    Effect.gen(function* () {
      const effects: Array<RolloutEffect> = []
      for (const key of keys) effects.push(yield* reader.RolloutEffectFor({ ...key, userId: actor.id }))
      if (effects.every((e) => e.kind === "library.revise"))
        return yield* writer.RevertLibraryChange({ userId: actor.id, effects: keys, ...options })
      const edits = effects
        .filter((e) => e.undoneAt === null)
        .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq)
        .map((e) => ({ effect: e, card: cardEdit(e) }))
      const path = edits[0]?.effect.targetId
      if (edits.length === 0 || path === undefined)
        return yield* new EffectUndoRefused({ message: "This change was undone already." })
      if (edits.some((e) => e.card === null || e.effect.targetId !== path))
        return yield* new EffectUndoRefused({ message: "Only edits of one item are reverted together." })
      const selected = edits.map(({ effect, card }) => {
        const { before: original, after: changed } = card!
        const of = changedUnits(original, changed)
        const fields = of.filter(
          (unit) => !effect.reversion?.fields.includes(unit) && (!options.fields || options.fields.includes(unit))
        )
        return { covered: { ...keyOf(effect), of, fields }, patch: { original, changed, fields } }
      })
      return yield* onHost(
        files.reverseCardFile(actor, {
          path,
          patches: selected.map(({ patch }) => patch).reverse(),
          choices: options.choices,
          dryRun: options.dryRun,
          record: (written) =>
            writer.RecordFileReversal({
              userId: actor.id,
              path,
              label: written.name,
              action: "revert",
              reversesId: null,
              headBefore: written.before,
              headAfter: written.after,
              fields: written.plan.fields,
              before: written.plan.before,
              after: written.plan.after,
              effects: selected.map(({ covered }) => covered)
            })
        })
      )
    }).pipe(Effect.tap((outcome) => (outcome.reversalId ? notifyReverted(actor.id) : Effect.void)))
  /** Takes a revert back (Redo): a library item's in the writer, a card file's on the files host. */
  const redo = (actor: User, reversalId: string, options: ReversalInput) =>
    Effect.gen(function* () {
      const record = yield* reader.FileReversal({ userId: actor.id, reversalId })
      if (record.targetKind === "entity")
        return yield* writer.RedoLibraryChange({ userId: actor.id, reversalId, ...options })
      const fields = options.fields ? record.fields.filter((f) => options.fields!.includes(f)) : record.fields
      return yield* onHost(
        files.reverseCardFile(actor, {
          path: record.targetId,
          patches: [{ original: docOfUnits(record.before), changed: docOfUnits(record.after), fields }],
          choices: options.choices,
          dryRun: options.dryRun,
          record: (written) =>
            writer.RecordFileReversal({
              userId: actor.id,
              path: record.targetId,
              label: written.name,
              action: "redo",
              reversesId: record.id,
              headBefore: written.before,
              headAfter: written.after,
              fields: written.plan.fields,
              before: written.plan.before,
              after: written.plan.after,
              effects: record.effects
            })
        })
      )
    }).pipe(Effect.tap((outcome) => (outcome.reversalId ? notifyReverted(actor.id) : Effect.void)))
  /**
   * The capabilities of the tools a chat of `kind` offers with `state`, as `grants` and the MCP
   * servers' rows stand; `story`, the story a side chat is beside.
   */
  const capabilitiesFrom = (
    kind: string,
    state: ChatState,
    grants: ReadonlyMap<string, CapabilityMode>,
    story: { readonly title: string | null } | null,
    connections: ReadonlyArray<{ readonly connection: McpConnection; readonly grant: CapabilityMode | null }>,
    /** An admin's saved workshop where the server allows commands without a sandbox (§3.7). */
    unsandboxed = false
  ) =>
    Effect.gen(function* () {
      const profile = execution.chatKinds.get(kind)
      if (!profile?.allowsOutside) return [] as Array<WorkshopCapability>
      const plan = execution.orchestrationModes.get(profile.planner)?.plan({ state, kind })
      const offered = new Set(
        (plan?.tools ?? []).flatMap((name) => {
          const capability = toolForKind(execution, kind, name)?.capability
          return capability ? [capability] : []
        })
      )
      // A setting shown with the capability it belongs to (Internet from commands, with Run commands).
      for (const entry of execution.workshopCapabilities.list())
        if (entry.alongside && offered.has(entry.alongside)) offered.add(entry.id)
      // Never offered to other accounts, nor where the server doesn't allow it.
      if (!unsandboxed || !files.unsandboxedAllowed) offered.delete(COMMANDS_UNSANDBOXED)
      // A kind that loads some of its tools as it goes may load a card's skills (spec/TOOL-LOADING.md §6).
      const loading = execution.toolLoadingProfiles.get(kind)
      const planned = plan?.tools ?? []
      if (loading && matchPatterns(planned, loading.immediate).length < planned.length) offered.add(CARD_SKILLS)
      // One row per MCP server the user can use (spec/MCP.md §13.3), after the built-ins, in
      // creation order: On or Off here, else the server's Workshops switch.
      const mcpEntry = execution.workshopCapabilities.get(MCP_CAPABILITY)
      const servers = mcpEntry
        ? connections.map(({ connection, grant }, index): WorkshopCapability => {
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
          })
        : []
      // Commands without a sandbox here: the row says why and how to fix it (spec §3.3).
      const noCommands = offered.has("commands") ? yield* files.commandsUnavailable() : null
      // Available, but without a cgroup per command: the row says the limits are weaker.
      const commandsNote = offered.has("commands") && !noCommands ? yield* files.commandsNote() : null
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
                : capability.id === "commands" && commandsNote
                  ? { ...capability, explanation: `${capability.explanation} ${commandsNote}` }
                  : capability
          )
        )
      return [...builtins, ...servers]
    })
  /** The capabilities of the tools this chat's kind offers, as they stand in it. */
  const capabilitiesOf = (userId: UserId, chatId: ChatId) =>
    Effect.gen(function* () {
      const chat = yield* reader.GetChat({ userId, chatId })
      if (!execution.chatKinds.get(chat.kind)?.allowsOutside) return []
      const state = foldState(
        yield* reader.StateEventsAt({ userId, chatId, slotId: chat.activeLeafSlotId, forkId: chat.currentForkId })
      )
      const grants = new Map<string, CapabilityMode>(
        (yield* reader.WorkshopGrants({ userId, chatId, now: Date.now() })).map((g) => [g.capability, g.mode])
      )
      // A choice that needs a consent counts only with the consent recorded for its text now.
      for (const capability of [...grants.keys()]) {
        const consent = consentTarget(execution, capability)
        if (!consent || grants.get(capability) === "off") continue
        const recorded = yield* reader.WorkshopGrants({ userId, chatId, now: Date.now(), target: consent })
        if (!recorded.some((g) => g.capability === capability && g.mode === "allow")) grants.delete(capability)
      }
      const story =
        state.workshopAttached === undefined
          ? null
          : yield* reader
              .GetChat({
                userId,
                chatId: state.workshopAttached as ChatId
              })
              .pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)))
      const connections = execution.workshopCapabilities.get(MCP_CAPABILITY)
        ? yield* reader.McpWorkshopConnections({ userId, chatId })
        : []
      const admin = (yield* CurrentUser).role === "admin"
      return yield* capabilitiesFrom(chat.kind, state, grants, story, connections, admin)
    })
  /**
   * What a workshop not made yet offers (owner, 2026-11-17: its composer is the saved one before
   * the first send): as `CreateWorkshop` makes it, with no choices of its own yet. Beside a
   * story, its reading of the story is allowed, as that write makes it.
   */
  const newCapabilitiesOf = (userId: UserId, attachTo: ChatId | undefined) =>
    Effect.gen(function* () {
      const story = attachTo === undefined ? null : yield* reader.GetChat({ userId, chatId: attachTo })
      if (attachTo !== undefined && (story?.status !== "active" || chatKinds.get(story.kind)?.allowsSideChat !== true))
        return yield* new NotFound({ entity: "chat", id: attachTo })
      const state: ChatState = attachTo === undefined ? foldState([]) : { ...foldState([]), workshopAttached: attachTo }
      const grants = new Map<string, CapabilityMode>(
        attachTo === undefined ? [] : [["chats.read", SIDE_STORY_READ_MODE]]
      )
      const connections = execution.workshopCapabilities.get(MCP_CAPABILITY)
        ? (yield* reader.McpStoryConnections({ userId })).map((connection) => ({ connection, grant: null }))
        : []
      return yield* capabilitiesFrom(WORKSHOP_KIND, state, grants, story, connections)
    })
  // Grants on a pending workshop must be choices that the saved workshop would offer.
  const checkNewGrants = (userId: UserId, attachTo: ChatId | undefined, grants: ReadonlyArray<WorkshopGrantChoice>) =>
    Effect.gen(function* () {
      if (grants.length === 0) return
      const offered = yield* newCapabilitiesOf(userId, attachTo)
      for (const grant of grants) {
        const row = offered.find((c) => c.id === grant.capability && (c.target ?? "") === (grant.target ?? ""))
        if (!row) return yield* new GrantRefused({ message: "A new workshop doesn't offer that." })
        if (grant.mode !== null && !row.modes.includes(grant.mode))
          return yield* new GrantRefused({ message: `“${row.label}” can't be set that way.` })
      }
    })

  return {
    ListWorkshopCapabilities: ({ chatId }) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        return yield* capabilitiesOf(userId, chatId)
      }).pipe(internal("ListWorkshopCapabilities")),
    ListNewWorkshopCapabilities: ({ attachTo }) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        return yield* newCapabilitiesOf(userId, attachTo)
      }).pipe(internal("ListNewWorkshopCapabilities")),
    // Only the user's own request reaches this: no tool is given these operations.
    SetWorkshopGrant: ({ chatId, capability, mode, target, consented }) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        const offered = (yield* capabilitiesOf(userId, chatId)).find(
          (c) => c.id === capability && (c.target ?? "") === (target ?? "")
        )
        if (!offered) return yield* new GrantRefused({ message: "This workshop doesn't offer that." })
        if (mode !== null && !offered.modes.includes(mode))
          return yield* new GrantRefused({ message: `“${offered.label}” can't be set that way.` })
        // A row with a consent (§3.7) is turned on only with the user's agreement, recorded here.
        const turnsOn = (mode ?? offered.defaultMode) !== "off"
        const consent = offered.confirm && !target ? consentTarget(execution, capability) : null
        if (offered.confirm && turnsOn && consented !== true)
          return yield* new GrantRefused({ message: `Turning on “${offered.label}” needs your agreement first.` })
        yield* writer.SetWorkshopGrant({
          userId,
          chatId,
          capability,
          mode,
          ...(target ? { target } : {}),
          ...(consent && turnsOn ? { consent } : {})
        })
        if (mode === "off") cancelCapability(chatId, capability, target)
        // Commands running with what this took away stop now.
        yield* files.recheckCommands([userId])
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
    RevertChange: ({ effects, ...options }) =>
      Effect.flatMap(CurrentUser, (user) => revert(user, effects, options)).pipe(internal("RevertChange")),
    RedoChange: ({ reversalId, ...options }) =>
      Effect.flatMap(CurrentUser, (user) => redo(user, reversalId, options)).pipe(internal("RedoChange")),
    UndoRolloutEffects: (input) =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.gen(function* () {
          const all = yield* reader.RolloutEffectsForRun({
            userId: user.id,
            chatId: input.chatId,
            rolloutId: input.rolloutId
          })
          // The reply's own changes and its subagents'.
          const rows = all.filter(
            (e) => (e.subagent?.rolloutId ?? e.rolloutId) === input.rolloutId && e.undoneAt === null
          )
          // Revert all of this reply (spec/WORKSHOP-CARDS.md §8.1): an item's edits are reverted
          // as its row's Revert does, three-way; everything else is undone as before.
          // An item the reply made goes to the bin with its edits, by the built undo.
          const made = new Set(rows.filter((e) => e.kind === "library.create").map((e) => e.targetId))
          const itemOf = (e: RolloutEffect) =>
            e.kind === "library.revise" && !made.has(e.targetId)
              ? `entity:${e.targetId}`
              : cardEdit(e)
                ? `file:${e.targetId}`
                : null
          const reverted = (e: RolloutEffect) =>
            e.reversion !== undefined && e.reversion.fields.length >= e.reversion.of.length
          if (!rows.some((e) => e.kind.startsWith("plugin.") || itemOf(e) !== null)) {
            const result = yield* writer.UndoRolloutEffects({ ...input, userId: user.id })
            yield* notifyUndo(user.id, result.undone)
            return result
          }
          const undone: Array<(typeof rows)[number]> = []
          const items = new Set<string>()
          for (const [at, row] of rows.entries()) {
            const item = itemOf(row)
            if (item !== null) {
              if (items.has(item) || reverted(row)) continue
              items.add(item)
              const group = rows.filter((e) => itemOf(e) === item)
              const outcome = yield* revert(user, group.map(keyOf), {}).pipe(Effect.exit)
              const name =
                /^(?:Edited|Created) the (?:card|lorebook|preset) (.*)$/s.exec(row.title)?.[1] ??
                cardEdit(row)?.name ??
                "This item"
              const reason =
                outcome._tag === "Failure"
                  ? `${name} couldn't be reverted. Open its change view to see why.`
                  : outcome.value.conflicts.length > 0
                    ? `${name} changed since in ${outcome.value.conflicts.length === 1 ? "a field" : `${outcome.value.conflicts.length} fields`} this reply changed. Open its change view to choose what to keep.`
                    : null
              if (reason !== null)
                return {
                  undone,
                  refused: { effect: row, reason },
                  left: rows.slice(at + 1).filter((e) => !group.includes(e))
                }
              undone.push(...group)
              continue
            }
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
    WorkshopFolderChoices: ({ chatId, stored, cardId }) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        const chat = yield* reader.GetChat({ userId, chatId })
        if (chat.kind !== "workshop") return yield* new NotFound({ entity: "workshop", id: chatId })
        const admin = (yield* CurrentUser).role === "admin"
        const current = stored === null ? FILES_TOP : yield* files.locateFolder(userId, stored, admin)
        const memory = yield* reader.WorkshopFolderMemory({ userId, cardId })
        const card = memory.card === null ? null : yield* files.locateFolder(userId, memory.card)
        const roots = admin ? yield* Effect.promise(() => files.hostFolders.roots().catch(() => [])) : []
        return {
          current,
          recent: memory.recent.map((folder) => folder.path),
          card: card !== null && card !== current ? card : null,
          hostFolders: roots.length > 0
        }
      }).pipe(internal("WorkshopFolderChoices")),
    ListHostFolders: ({ path }) =>
      Effect.gen(function* () {
        if ((yield* CurrentUser).role !== "admin")
          return yield* new Forbidden({ message: "Only an admin can choose a folder on the server." })
        return yield* Effect.tryPromise({
          try: () => files.hostFolders.list(path),
          catch: (error) =>
            new HostFolderRefused({
              message: error instanceof HostFolderRefusal ? error.message : `${path ?? "The folder"} couldn't be read.`
            })
        })
      }).pipe(internal("ListHostFolders")),
    CreateWorkshop: (input) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        yield* checkNewGrants(userId, input.attachTo, input.grants ?? [])
        return yield* writer.CreateWorkshop({ ...input, userId })
      }).pipe(internal("CreateWorkshop")),
    StartWorkshop: (input) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        const existing = yield* reader.GetWorkshopStart({ userId, requestId: input.requestId })
        if (existing) return existing
        if (input.first._tag === "Generate" && Option.isNone(generator))
          return yield* new GenerationUnavailable({
            message: "This server has nothing to generate with yet: the context assembler isn't built."
          })
        yield* checkNewGrants(userId, input.attachTo, input.grants ?? [])
        let prepared: Parameters<typeof writer.StartWorkshop>[0] = { ...input, userId }
        if (input.first._tag === "Send" && input.first.content !== "") {
          const { first, ...choices } = input
          const rewritten = yield* reader
            .RewriteWorkshopStart({ ...choices, userId, content: first.content })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.as(
                  Effect.logWarning("rewriting the first workshop message failed; it's kept as it is", cause),
                  null
                )
              )
            )
          if (rewritten && (rewritten.applied.length || rewritten.failed.length))
            prepared = {
              ...prepared,
              first: { ...first, content: rewritten.text },
              rewrite: {
                applied: rewritten.applied,
                failed: rewritten.failed,
                raw: rewritten.text === first.content ? null : first.content,
                rawReasoning: null
              }
            }
        }
        const { generate, ...started } = yield* writer.StartWorkshop(prepared)
        if (generate !== undefined)
          yield* generations.start({
            userId,
            chatId: started.chat.id,
            slotId: started.slotId,
            forkId: started.forkId,
            versionId: generate
          })
        return started
      }).pipe(Effect.uninterruptible, internal("StartWorkshop"))
  } satisfies Parameters<typeof WorkshopApi.of>[0]
})
