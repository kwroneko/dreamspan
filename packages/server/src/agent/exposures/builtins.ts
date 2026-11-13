import { documentDiff, documentChangeRows, safeAgentDocument, executableNotice } from "../../db/agentDocuments.ts"
import { promptPreset } from "@rp/shared/docs/preset.ts"
import { builtinPreset } from "../../db/assemblySources.ts"
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import { workshopLimits } from "../../workshopLimits.ts"
import { chatKinds } from "@rp/shared/chatKinds.ts"
import { chatCursor } from "@rp/shared/chatApi.ts"
import type { Chat } from "@rp/shared/chat.ts"
import { AppApi } from "@rp/shared/api.ts"
import { Schema, Effect } from "effect"
import { CastChange } from "@rp/shared/chatSetupApi.ts"
import type { EntityKind, LibraryRef } from "@rp/shared/library.ts"
import type { ToolContext } from "../tools.ts"
import type { OperationExposure } from "../operations.ts"
import { resolveLibrary } from "../tools/library.ts"

const name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
const label = Schema.String.check(Schema.isMaxLength(200))
const optional = Schema.optionalKey
const fail = (message: string) => Effect.fail(new Error(message))
const library = (ctx: ToolContext, kind: EntityKind, value: unknown) =>
  Effect.gen(function* () {
    const found = yield* resolveLibrary(ctx, kind, String(value))
    if ("error" in found) return yield* fail(found.error)
    const key = `operation:proof:${ctx.toolCallId}`
    const proof = (ctx.cache.get(key) ?? {}) as { chat?: unknown; refs?: unknown[] }
    ctx.cache.set(key, {
      ...proof,
      refs: [
        ...(proof.refs ?? []),
        { refId: found.ref.id, rowVersion: found.ref.rowVersion, archivedAt: found.ref.archivedAt ?? null }
      ]
    })
    return found.ref
  })
const resolveChat = (ctx: ToolContext, value: unknown) =>
  Effect.gen(function* () {
    const wanted = String(value)
    let before: ReturnType<typeof chatCursor> | null = null
    const matches: Chat[] = []
    const candidates: Chat[] = []
    do {
      const page: readonly Chat[] = yield* ctx.reader.ListChats({ userId: ctx.userId, limit: 500, before })
      candidates.push(...page.slice(0, Math.max(0, 5 - candidates.length)))
      const exact = page.find((chat) => chat.id === wanted)
      if (exact) return exact
      matches.push(...page.filter((chat) => chat.title.toLocaleLowerCase() === wanted.toLocaleLowerCase()))
      const last = page.at(-1)
      before = page.length === 500 && last ? chatCursor(last) : null
    } while (before)
    if (matches.length !== 1)
      return yield* fail(
        matches.length
          ? `Several chats match. Choose an id: ${JSON.stringify(matches.map((chat) => ({ id: chat.id, name: chat.title })))}`
          : `No chat matches ${JSON.stringify(wanted)}. Candidates: ${JSON.stringify(candidates.map((chat) => ({ id: chat.id, name: chat.title })))}. Use list_chats.`
      )
    return matches[0]!
  })
const chatPayload = (ctx: ToolContext, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const chat = yield* resolveChat(ctx, args.chat)
    const info = yield* ctx.reader.WorkshopOperationInfo({ userId: ctx.userId, chatId: chat.id })
    ctx.cache.set(`operation:proof:${ctx.toolCallId}`, { chat: info.proof })
    return { chatId: chat.id, forkId: chat.currentForkId, slotId: chat.activeLeafSlotId }
  })
const exposure = (
  id: string,
  rpc: string,
  capability: string,
  effect: OperationExposure["effect"],
  explanation: string,
  extra: Partial<OperationExposure> = {}
): OperationExposure => ({
  id,
  operation: { rpc },
  capability,
  effect,
  label: explanation,
  explanation,
  description: `${explanation} Uses your saved items only. Ambiguous names must be replaced with an id. Changes have Undo.`,
  ...extra
})
const refArgs = { kind: Schema.Literals(["card", "preset", "lorebook", "note"]), item: name }
const refPayload = (args: Record<string, unknown>, ctx: ToolContext) =>
  Effect.gen(function* () {
    const ref = yield* library(ctx, args.kind as EntityKind, args.item)
    return { refId: ref.id, expectedRowVersion: ref.rowVersion }
  })
const changeSchemas = [
  Schema.TaggedStruct("Persona", { entityId: name }),
  Schema.TaggedStruct("Model", { connection: name, model: name }),
  Schema.TaggedStruct("Preset", { ref: Schema.NullOr(name) }),
  Schema.TaggedStruct("Lorebook", { ref: name, active: Schema.Boolean }),
  Schema.TaggedStruct("CardLorebook", { entityId: name, on: Schema.Boolean }),
  Schema.TaggedStruct("AgentEnabled", { on: Schema.Boolean }),
  Schema.TaggedStruct("AgentTools", { tools: Schema.Array(name).check(Schema.isMaxLength(100)) }),
  Schema.TaggedStruct("CardsRotation", { on: Schema.Boolean }),
  Schema.TaggedStruct("ReplyOrder", { order: name }),
  Schema.TaggedStruct("Join", { entityId: name }),
  Schema.TaggedStruct("Leave", { entityId: name }),
  Schema.TaggedStruct("Swap", { entityId: name, replaces: name })
]
export const exposedCastChanges = changeSchemas.map((s) => s.fields._tag.ast.literal)

export const builtinOperationExposures: readonly OperationExposure[] = [
  exposure("rename_chat", "RenameChat", "chats.setup", "setup", "Rename a chat", {
    parameters: Schema.Struct({ chat: name, name: label }),
    adapt: (args, ctx) => chatPayload(ctx, args).pipe(Effect.map(({ chatId }) => ({ chatId, name: args.name })))
  }),
  exposure("change_chat", "ChangeCast", "chats.setup", "setup", "Change a chat's cast or settings", {
    parameters: Schema.Struct({ chat: name, change: Schema.Union(changeSchemas) }),
    adapt: (args, ctx) =>
      Effect.gen(function* () {
        const position = yield* chatPayload(ctx, args)
        const change = { ...(args.change as Record<string, unknown>) }
        for (const key of ["entityId", "replaces"])
          if (change[key]) change[key] = (yield* library(ctx, "card", change[key])).entityId
        if (change.ref)
          change.ref = (yield* library(ctx, change._tag === "Preset" ? "preset" : "lorebook", change.ref)).id
        if (change._tag === "Model") {
          const connections = yield* ctx.reader.ListConnections({ userId: ctx.userId })
          const matches = connections.filter(
            (c) =>
              c.id === change.connection || c.name.toLocaleLowerCase() === String(change.connection).toLocaleLowerCase()
          )
          if (matches.length !== 1)
            return yield* fail(
              `Choose one connection by id: ${JSON.stringify(matches.map((c) => ({ id: c.id, name: c.name })))}`
            )
          change.connection = matches[0]!.id
          const models = yield* ctx.reader.ListModels({
            userId: ctx.userId,
            connectionId: matches[0]!.id,
            includeHidden: false
          })
          const matchesModel = models.filter(
            (m) =>
              m.id === change.model ||
              [m.key, m.overrides.name, m.upstream.name].some(
                (value) => value?.toLocaleLowerCase() === String(change.model).toLocaleLowerCase()
              )
          )
          if (matchesModel.length !== 1)
            return yield* fail(
              `Choose one model by id: ${JSON.stringify(matchesModel.map((m) => ({ id: m.id, name: m.key })))}`
            )
          change.model = matchesModel[0]!.id
        }
        return {
          ...position,
          change: yield* Schema.decodeUnknownEffect(CastChange)(change, { onExcessProperty: "error" })
        }
      })
  }),
  exposure("create_preset", "CreatePreset", "library.write", "library", "Create a preset", {
    describe: (payload) =>
      Effect.succeed({
        title: `Create the preset “${String(payload.label)}”`,
        rows: [
          ...documentChangeRows(documentDiff({}, promptPreset(builtinPreset))),
          { label: "Executable content", value: executableNotice }
        ],
        changes: documentDiff({}, promptPreset(builtinPreset))
      })
  }),
  exposure("create_lorebook", "CreateLorebook", "library.write", "library", "Create a lorebook", {
    describe: (payload) =>
      Effect.succeed({
        title: `Create the lorebook “${String(payload.label)}”`,
        rows: [{ label: "Entries", value: "An empty lorebook; entries can be added afterward." }]
      })
  }),
  exposure("fork_variant", "ForkVariant", "library.write", "library", "Copy a library entry", {
    parameters: Schema.Struct({ ...refArgs, label: name, subtitle: label }),
    adapt: (args, ctx) =>
      refPayload(args, ctx).pipe(
        Effect.map(({ refId }) => ({ refId, label: args.label, subtitle: args.subtitle, moveDrafts: false }))
      )
  }),
  exposure("rename_ref", "RenameRef", "library.write", "library", "Rename a library entry", {
    parameters: Schema.Struct({ ...refArgs, label: name, subtitle: label }),
    adapt: (args, ctx) =>
      refPayload(args, ctx).pipe(Effect.map((ref) => ({ ...ref, label: args.label, subtitle: args.subtitle })))
  }),
  exposure("set_ref_archived", "SetRefArchived", "library.write", "library", "Archive or restore a library entry", {
    parameters: Schema.Struct({ ...refArgs, archived: Schema.Boolean }),
    adapt: (args, ctx) => refPayload(args, ctx).pipe(Effect.map(({ refId }) => ({ refId, archived: args.archived }))),
    describe: (payload, ctx) =>
      ctx.reader.OpenEditor({ userId: ctx.userId, refId: payload.refId as RefId }).pipe(
        Effect.map(({ ref }) => ({
          title: `${payload.archived ? "Archive" : "Restore from archive"} the ${ref.kind} “${ref.label}”`,
          rows: []
        }))
      )
  }),
  exposure("restore_revision", "RestoreRevision", "library.write", "library", "Restore a library revision", {
    parameters: Schema.Struct({ ...refArgs, revision: name }),
    adapt: (args, ctx) => refPayload(args, ctx).pipe(Effect.map((ref) => ({ ...ref, revisionId: args.revision }))),
    describe: (payload, ctx) =>
      Effect.gen(function* () {
        const { ref, doc } = yield* ctx.reader.OpenEditor({ userId: ctx.userId, refId: payload.refId as RefId })
        const revision = yield* ctx.reader.GetRevisionDoc({
          userId: ctx.userId,
          refId: ref.id,
          revisionId: payload.revisionId as RevisionId
        })
        const changes = documentDiff(doc, safeAgentDocument(ref.kind, doc, revision))
        return {
          title: `Restore a revision of the ${ref.kind} “${ref.label}”`,
          rows: [...documentChangeRows(changes), { label: "Executable content", value: executableNotice }],
          changes
        }
      })
  }),
  exposure("set_card_favourite", "SetCardFavourite", "library.write", "library", "Set a card's favourite status", {
    parameters: Schema.Struct({ card: name, favourite: Schema.Boolean }),
    adapt: (args, ctx) =>
      library(ctx, "card", args.card).pipe(Effect.map((ref) => ({ entityId: ref.entityId, favourite: args.favourite })))
  }),
  exposure("set_chat_pin", "SetChatPin", "chats.setup", "setup", "Pin or unpin a chat", {
    parameters: Schema.Struct({ chat: name, pinned: Schema.Boolean }),
    adapt: (args, ctx) =>
      chatPayload(ctx, args).pipe(Effect.map(({ chatId, slotId }) => ({ chatId, leaf: slotId, pinned: args.pinned })))
  }),
  exposure("change_generation_defaults", "ChangeGenerationDefaults", "settings", "setup", "Change generation defaults"),
  exposure("list_library", "ListLibrary", "library.read", "read", "List your library", {
    parameters: Schema.Struct({
      kind: Schema.Literals(["card", "preset", "lorebook", "note"]),
      query: optional(label),
      limit: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })))
    }),
    adapt: (args) => Effect.succeed({ kind: args.kind, withFilterData: true }),
    label: "Looked in your library",
    summarize: (args) => String(args.query ?? args.kind),
    render: (result, args) => {
      const words = String(args.query ?? "")
        .toLocaleLowerCase()
        .split(/\s+/)
        .filter(Boolean)
      const entries = (result as ReadonlyArray<LibraryRef>)
        .map((ref) => ({
          id: ref.id,
          entityId: ref.entityId,
          name: ref.label,
          subtitle: ref.subtitle,
          tags: ref.filterData?.tags ?? []
        }))
        .filter((ref) =>
          words.every((word) => `${ref.name} ${ref.subtitle} ${ref.tags.join(" ")}`.toLocaleLowerCase().includes(word))
        )
      const limit = Number(args.limit ?? 20)
      return JSON.stringify({ entries: entries.slice(0, limit), remaining: Math.max(0, entries.length - limit) })
    }
  }),
  exposure("list_chats", "ListChats", "chats.read", "read", "List your chats", {
    parameters: Schema.Struct({ limit: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))) }),
    adapt: (args) => Effect.succeed({ limit: args.limit ?? 20, before: null })
  }),
  exposure("get_cast", "GetCast", "chats.read", "read", "Read a chat's cast and settings", {
    parameters: Schema.Struct({ chat: name }),
    adapt: (args, ctx) => chatPayload(ctx, args)
  }),
  exposure("list_revisions", "ListRevisions", "library.read", "read", "List a library entry's revisions", {
    parameters: Schema.Struct(refArgs),
    adapt: (args, ctx) => refPayload(args, ctx).pipe(Effect.map(({ refId }) => ({ refId, limit: 50 })))
  }),
  {
    ...exposure("history_search", "PreviewHistory", "chats.read", "read", "Search a chat's history"),
    operation: { command: "history.search" },
    parameters: AppApi.requests.get("PreviewHistory")!.payloadSchema
  },
  {
    ...exposure("history_rename", "RenameHistory", "chats.rewrite", "setup", "Rename text in history"),
    operation: { command: "history.rename" },
    parameters: AppApi.requests.get("RenameHistory")!.payloadSchema,
    adapt: (args, ctx) =>
      Effect.gen(function* () {
        const targets = yield* ctx.reader.RenameHistoryTargets({ userId: ctx.userId, entityId: args.entityId as never })
        const selected = targets
          .filter(
            (target) =>
              args.scope === "all" ||
              (args.scope === "this" && target.chatId === args.chatId && target.forkId === args.forkId)
          )
          .sort((a, b) => a.chatId.localeCompare(b.chatId) || a.forkId.localeCompare(b.forkId))
        if (selected.length > workshopLimits.listItems)
          return yield* fail("This rename affects too many branches. Choose one chat and branch instead.")
        const chats = yield* Effect.forEach([...new Set(selected.map((target) => target.chatId))], (chatId) =>
          ctx.reader.WorkshopOperationInfo({ userId: ctx.userId, chatId }).pipe(Effect.map((info) => info.proof))
        )
        ctx.cache.set(`operation:proof:${ctx.toolCallId}`, { chats, historyTargets: selected })
        return args
      })
  },
  {
    ...exposure("read_settings", "GetGenerationDefaults", "settings", "read", "Read your agent-changeable settings"),
    operation: { command: "settings.read" },
    parameters: Schema.Struct({})
  },
  {
    ...exposure("change_setting", "ChangeGenerationDefaults", "settings", "setup", "Change one app setting"),
    operation: { command: "settings.change" },
    parameters: Schema.Struct({ key: name, value: Schema.Unknown }),
    adapt: (args, ctx) =>
      Effect.gen(function* () {
        const info = yield* ctx.reader.WorkshopOperationInfo({ userId: ctx.userId })
        const setting = info.settings.find((s) => s.key === args.key)
        if (!setting)
          return yield* fail("This setting is not agent-changeable. Use read_settings for the allowed keys.")
        return { key: setting.key, value: args.value, expectedRevision: setting.revision }
      })
  },
  exposure(
    "generate_reply",
    "Generate",
    "generate",
    "outside",
    "Generate a reply in another chat (sends it to its chosen provider)",
    {
      parameters: Schema.Struct({ chat: name, speaker: optional(name) }),
      adapt: (args, ctx) =>
        Effect.gen(function* () {
          const { chatId, forkId, slotId } = yield* chatPayload(ctx, args)
          if (chatId === ctx.chatId)
            return yield* fail("Choose another chat; this workshop is already writing a reply.")
          const target = yield* ctx.reader.GetChat({ userId: ctx.userId, chatId })
          if (chatKinds.get(target.kind)?.allowsOutside !== false)
            return yield* fail("Replies in another workshop or an unavailable chat kind are not allowed.")
          const proof = ctx.cache.get(`operation:proof:${ctx.toolCallId}`) as { chat?: { model?: unknown } }
          if (!proof.chat?.model) return yield* fail("Choose a model in that chat before asking for a reply.")
          return {
            chatId,
            forkId,
            parentSlotId: slotId,
            branch: false,
            ...(args.speaker ? { speakerEntityId: (yield* library(ctx, "card", args.speaker)).entityId } : {})
          }
        }),
      after: (result, _args, ctx) =>
        Effect.gen(function* () {
          const reply = result as { _tag: string; entry?: { version: { id: import("@rp/shared/chat.ts").VersionId } } }
          if (!reply.entry) return { text: "The reply could not be started without queueing it.", isError: true }
          let version = yield* ctx.reader.GetVersion({ userId: ctx.userId, versionId: reply.entry.version.id })
          while (version.status === "generating") {
            yield* Effect.sleep("50 millis")
            version = yield* ctx.reader.GetVersion({ userId: ctx.userId, versionId: version.id })
          }
          return { text: version.content, ...(version.status === "failed" ? { isError: true } : {}) }
        })
    }
  )
]
