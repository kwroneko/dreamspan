import { storyWriteChat } from "../storyWriteScope.ts"
import { checkStoryReadScope } from "../storyReadScope.ts"
import { documentDiff, documentChangeRows, safeAgentDocument, executableNotice } from "../../db/agentDocuments.ts"
import { promptPreset } from "@dreamspan/shared/docs/preset.ts"
import { builtinPreset } from "../../db/assemblySources.ts"
import type { RefId, RevisionId } from "@dreamspan/shared/library.ts"
import { workshopLimits } from "../../workshopLimits.ts"
import { chatKinds } from "@dreamspan/shared/chatKinds.ts"
import { chatCursor } from "@dreamspan/shared/chatApi.ts"
import type { Chat } from "@dreamspan/shared/chat.ts"
import { AppApi } from "@dreamspan/shared/api.ts"
import { Schema, Effect } from "effect"
import { SubagentTypes } from "@dreamspan/shared/subagents.ts"
import { executionRegistry } from "../../execution.ts"
import { changesRegisteredInstructions, checkTypeList, subagentToolCatalog } from "../subagentTypeEdits.ts"
import { CastChange } from "@dreamspan/shared/chatSetupApi.ts"
import type { EntityKind, LibraryRef } from "@dreamspan/shared/library.ts"
import type { ToolContext, WorkshopStoryRead } from "../tools.ts"
import type { OperationExposure } from "../operations.ts"
import { resolveLibrary } from "../tools/library.ts"
import { chatNotesAt } from "../../chat/chatNotesAt.ts"
import type { ChatNote } from "@dreamspan/shared/chatSetupApi.ts"
import type { SharedNote } from "@dreamspan/shared/editorApi.ts"
import type { ExportFormatInfo } from "@dreamspan/shared/libraryImport.ts"
import type { StImportJob, StImportReport } from "@dreamspan/shared/stImportApi.ts"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { escapeToolData } from "../toolData.ts"

const name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
const label = Schema.String.check(Schema.isMaxLength(200))
const optional = Schema.optionalKey
const fail = (message: string) => Effect.fail(new Error(message))

const SUBAGENT_TYPES = "subagents.types"

/** A `subagents.types` value as the settings editor would store it, or why it's refused. */
const checkedSubagentTypes = (value: unknown) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(SubagentTypes)(value).pipe(
      Effect.mapError(() => new Error("That isn't a list of subagent types. Use read_settings to see the form."))
    )
    const registry = yield* Effect.scoped(executionRegistry)
    const checked = checkTypeList(registry.subagentTypes.list(), subagentToolCatalog(registry), decoded)
    if ("rejected" in checked) return yield* fail(checked.rejected)
    return checked.types
  })
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
export const resolveChat = (ctx: ToolContext, value: unknown) =>
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
    const chat = yield* storyWriteChat(ctx, yield* resolveChat(ctx, args.chat))
    const info = yield* ctx.reader.WorkshopOperationInfo({
      userId: ctx.userId,
      chatId: chat.id,
      ...(chat.storyTarget ? { storyAt: chat.storyTarget } : {})
    })
    ctx.cache.set(`operation:proof:${ctx.toolCallId}`, {
      chat: info.proof,
      ...(chat.storyTarget
        ? { storyAt: chat.storyTarget, upTo: chat.upTo, branchLabel: chat.branchLabel, branchNaming: chat.branchNaming }
        : {})
    })
    return { chatId: chat.id, forkId: chat.currentForkId, slotId: chat.activeLeafSlotId }
  })
const storyReads: Readonly<Record<string, WorkshopStoryRead>> = {
  rename_chat: "positioned",
  change_chat: "positioned",
  set_chat_pin: "positioned",
  get_cast: "positioned",
  generate_reply: "positioned",
  history_rename: "positioned",
  history_search: "refused",
  list_chats: "refused",
  create_preset: "library",
  create_lorebook: "library",
  fork_variant: "library",
  rename_ref: "library",
  set_ref_archived: "library",
  restore_revision: "library",
  set_card_favourite: "library",
  list_library: "library",
  list_revisions: "library",
  // A saved card's text into its own-turn note: library only (ownturn1, merge-batch10).
  move_card_text: "library",
  change_generation_defaults: "account",
  read_settings: "account",
  change_setting: "account",
  // Notes of the library (a card's, a shared one) and files into it: no story position.
  list_shared_notes: "library",
  create_card_note: "library",
  create_shared_note: "library",
  unlink_note: "library",
  delete_note: "library",
  set_persona: "library",
  list_export_formats: "library",
  import_library_file: "library",
  // A chat's notes are read and made where the tab shows its story.
  list_chat_notes: "positioned",
  create_chat_note: "positioned",
  // Import jobs name files from every chat of the account.
  list_imports: "refused",
  read_import: "refused"
}
/** One page of an app-built list: the offset to ask for next stays outside the quoted rows. */
const pageArgs = {
  offset: optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))),
  limit: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })))
}
/**
 * A page ends where the quoted result the model is sent would run out (TOOL_RESULT_CHARS, with
 * the escaping and the ids repeated in the metadata), so `nextOffset` never skips rows it didn't see.
 */
const PAGE_CHARS = 11_000
const paged = <T>(rows: ReadonlyArray<T>, args: Record<string, unknown>, fallback = 20) => {
  const offset = Number(args.offset ?? 0)
  const entries: Array<T> = []
  let size = 0
  for (const row of rows.slice(offset, offset + Number(args.limit ?? fallback))) {
    const cost = escapeToolData(JSON.stringify(row)).length + 200
    if (entries.length > 0 && size + cost > PAGE_CHARS) break
    entries.push(row)
    size += cost
  }
  const remaining = Math.max(0, rows.length - offset - entries.length)
  return { entries, remaining, offset, nextOffset: remaining > 0 ? offset + entries.length : null }
}
/** The chat a positioned call acts on, by the title its proof saved. */
const provedChat = (ctx: ToolContext) =>
  (ctx.cache.get(`operation:proof:${ctx.toolCallId}`) as { chat?: { title?: string } } | undefined)?.chat?.title ??
  "this chat"
const cut = (value: unknown, limit: number) => {
  const text = String(value ?? "")
  return text.length > limit ? { content: text.slice(0, limit), contentCut: true } : { content: text }
}
const savedRef = (ref: LibraryRef) => ({
  id: ref.id,
  entityId: ref.entityId,
  revision: ref.headRevisionId,
  kind: ref.kind,
  name: ref.label
})
const noteText = Schema.String.check(Schema.isMaxLength(workshopLimits.textChars))
/** A note of the library by id or by its one name. A chat's own notes are named at their chat. */
const libraryNote = (ctx: ToolContext, value: unknown) =>
  Effect.gen(function* () {
    const ref = yield* library(ctx, "note", value)
    const saved = yield* ctx.reader.OpenEditor({ userId: ctx.userId, refId: ref.id })
    const owner = (saved.doc.owner ?? {}) as { card?: string; chat?: string; shared?: string }
    if (owner.chat !== undefined)
      return yield* fail("That note belongs to one chat. Use list_chat_notes and the chat's own Notes.")
    return { ref, saved, owner }
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
  ...(storyReads[id] ? { storyRead: storyReads[id] } : {}),
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
  Schema.TaggedStruct("AgentTools", {
    tools: Schema.NullOr(Schema.Array(name).check(Schema.isMaxLength(100))).annotate({
      description: "The tools the chat offers, by id; null clears the chat's choice so it follows the app default."
    })
  }),
  Schema.TaggedStruct("CardsRotation", { on: Schema.Boolean }),
  Schema.TaggedStruct("ReplyOrder", { order: name }),
  Schema.TaggedStruct("Join", { entityId: name }),
  Schema.TaggedStruct("Leave", { entityId: name }),
  Schema.TaggedStruct("Swap", { entityId: name, replaces: name }),
  Schema.TaggedStruct("Note", {
    note: name.annotate({ description: "A note of this chat or of one of its cards, by id from list_chat_notes." }),
    active: Schema.Boolean
  })
]
export const exposedCastChanges = changeSchemas.map((s) => s.fields._tag.ast.literal)

export const builtinOperationExposures: readonly OperationExposure[] = [
  exposure("rename_chat", "RenameChat", "chats.setup", "setup", "Rename a chat", {
    parameters: Schema.Struct({ chat: name, name: label }),
    adapt: (args, ctx) => chatPayload(ctx, args).pipe(Effect.map(({ chatId }) => ({ chatId, name: args.name })))
  }),
  exposure("change_chat", "ChangeCast", "chats.setup", "setup", "Change a chat's cast or settings", {
    parameters: Schema.Struct({ chat: name, change: Schema.Union(changeSchemas) }),
    // A note's switch says which note and where; other changes keep the generic rows.
    describe: (payload, ctx) => {
      const change = payload.change as { _tag: string; active?: boolean }
      const note = String(ctx.cache.get(`note:title:${ctx.toolCallId}`) ?? "")
      return Effect.succeed(
        change._tag === "Note"
          ? { title: `Switch ${change.active ? "on" : "off"} the note “${note}” in “${provedChat(ctx)}”`, rows: [] }
          : null
      )
    },
    adapt: (args, ctx) =>
      Effect.gen(function* () {
        const position = yield* chatPayload(ctx, args)
        const change = { ...(args.change as Record<string, unknown>) }
        if (change._tag === "Note") {
          // The switch is this branch's, at the position shown: other branches keep theirs.
          const notes = yield* chatNotesAt(ctx.reader, ctx.userId, position)
          const wanted = String(change.note)
          const byId = notes.filter((n) => n.ref.id === wanted || n.ref.entityId === wanted)
          const found = byId.length
            ? byId
            : notes.filter((n) => String(n.doc.title ?? n.ref.label).toLocaleLowerCase() === wanted.toLocaleLowerCase())
          if (found.length !== 1) return yield* fail("Choose one note by its id from list_chat_notes.")
          const note = found[0]!
          if (typeof note.doc.move_group === "string")
            return yield* fail("This note is part of a moved group. Switch the group in the chat's Notes.")
          if (note.active === change.active)
            return yield* fail(`That note is already ${change.active ? "on" : "off"} at this position.`)
          ctx.cache.set(`note:title:${ctx.toolCallId}`, String(note.doc.title ?? note.ref.label))
          return {
            ...position,
            change: yield* Schema.decodeUnknownEffect(CastChange)(
              { _tag: "Note", entityId: note.ref.entityId, active: change.active },
              { onExcessProperty: "error" }
            )
          }
        }
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
  exposure(
    "move_card_text",
    "MoveToOwnTurnNote",
    "library.write",
    "library",
    "Move a saved card passage to an own-turn note",
    {
      parameters: Schema.Struct({
        card: name,
        field: Schema.Literals([
          "description",
          "personality",
          "scenario",
          "mes_example",
          "system_prompt",
          "post_history_instructions"
        ]),
        find: Schema.String.check(Schema.isMinLength(1)),
        framing: optional(Schema.String)
      }),
      describe: (payload) => {
        const before = String(payload.text),
          at = Number(payload.at),
          end = at + Number(payload.length)
        return Effect.succeed({
          title: "Move card text to an own-turn note",
          rows: [
            { label: "Own-turn note", value: before.slice(at, end) },
            {
              label: "When and where",
              value: "Only on its card’s turns, at the preset’s Own-turn notes. The original card field stays saved."
            }
          ],
          changes: [{ field: String(payload.field), before, after: before.slice(0, at) + before.slice(end) }]
        })
      },
      adapt: (args, ctx) =>
        Effect.gen(function* () {
          const ref = yield* library(ctx, "card", args.card)
          const saved = yield* ctx.reader.OpenEditor({ userId: ctx.userId, refId: ref.id })
          const notes = yield* ctx.reader.ListCardNotes({ userId: ctx.userId, cardRefId: ref.id })
          const previous = notes.find(
            (note) => (note.doc.replaces as { field?: string } | undefined)?.field === args.field
          )
          const text = String(previous?.doc.content ?? saved.doc[String(args.field)] ?? "")
          const find = String(args.find),
            at = text.indexOf(find)
          if (at < 0 || text.indexOf(find, at + 1) >= 0)
            return yield* fail("Find must occur exactly once in the current shared text. Read the card again.")
          return {
            cardRefId: ref.id,
            expectedRevisionId: saved.ref.headRevisionId,
            field: args.field,
            text,
            at,
            length: find.length,
            ...(args.framing === undefined ? {} : { framing: args.framing })
          }
        })
    }
  ),
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
    adapt: (args, ctx) => checkStoryReadScope(ctx).pipe(Effect.as({ limit: args.limit ?? 20, before: null }))
  }),
  exposure("get_cast", "GetCast", "chats.read", "read", "Read a chat's cast and settings", {
    parameters: Schema.Struct({ chat: name }),
    adapt: (args, ctx) =>
      Effect.gen(function* () {
        const payload = yield* chatPayload(ctx, args)
        yield* checkStoryReadScope(ctx, payload.chatId)
        return payload
      })
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
        // Subagent types are checked as the settings editor checks them (spec/SUBAGENTS.md §10).
        const value = setting.key === SUBAGENT_TYPES ? yield* checkedSubagentTypes(args.value) : args.value
        return { key: setting.key, value, expectedRevision: setting.revision }
      }),
    // Rewriting a built-in or plugin type's instructions changes what every chat's subagents of
    // that type are told: it always asks, and only for this call (DESIGN §7.10 [P]).
    asksWhen: (payload, ctx) =>
      Effect.gen(function* () {
        if (payload.key !== SUBAGENT_TYPES) return false
        const registry = yield* Effect.scoped(executionRegistry)
        const before = (yield* ctx.reader.SubagentSettings({ userId: ctx.userId })).types
        return changesRegisteredInstructions(registry.subagentTypes.list(), before, payload.value as SubagentTypes)
      })
  },
  // --- Notes (DESIGN §4.1): the Notes editors' own operations.
  exposure("list_shared_notes", "ListSharedNotes", "library.read", "read", "List your shared notes", {
    label: "Looked through your shared notes",
    description:
      "Lists shared notes (texts card and chat notes can show): ids, titles, each text's start and how many notes show it. Page with offset; read one with read_note.",
    parameters: Schema.Struct({ query: optional(label), ...pageArgs }),
    adapt: (args) => Effect.succeed(args.query === undefined ? {} : { query: args.query }),
    summarize: (args) => String(args.query ?? "shared notes"),
    render: (result, args) =>
      JSON.stringify(
        paged(
          (result as ReadonlyArray<SharedNote>).map((note) => ({
            ...savedRef(note.ref),
            title: note.title,
            excerpt: note.excerpt,
            usedBy: note.usedBy
          })),
          args
        )
      )
  }),
  exposure("list_chat_notes", "ListChatNotes", "chats.read", "read", "Read a chat's notes", {
    label: "Read a chat's notes",
    description:
      "Lists a chat's and its cards' notes at the position shown, each on or off there. Texts are cut: give note for one whole. Page with offset. Switch with change_chat.",
    parameters: Schema.Struct({ chat: name, note: optional(name), ...pageArgs }),
    adapt: (args, ctx) =>
      Effect.gen(function* () {
        const payload = yield* chatPayload(ctx, args)
        yield* checkStoryReadScope(ctx, payload.chatId)
        if (args.note !== undefined) {
          const notes = yield* chatNotesAt(ctx.reader, ctx.userId, payload)
          if (!notes.some((n) => n.ref.id === args.note || n.ref.entityId === args.note))
            return yield* fail("Name the note by its id from list_chat_notes.")
        }
        return payload
      }),
    describe: (_payload, ctx) => Effect.succeed({ title: `Read the notes of “${provedChat(ctx)}”`, rows: [] }),
    summarize: (args) => String(args.chat),
    render: (result, args) => {
      const one = args.note === undefined ? null : String(args.note)
      const rows = (result as ReadonlyArray<ChatNote>)
        .filter((note) => one === null || note.ref.id === one || note.ref.entityId === one)
        .map((note) => ({
          ...savedRef(note.ref),
          title: String(note.doc.title ?? note.ref.label),
          card: note.card,
          active: note.active,
          showsSharedNote: note.linked !== null,
          // One note asked for comes whole; a longer result pages as every result does.
          ...(one === null ? cut(note.doc.content, 1500) : { content: String(note.doc.content ?? "") })
        }))
      return JSON.stringify(one === null ? paged(rows, args, 10) : { entries: rows, remaining: 0, nextOffset: null })
    }
  }),
  exposure("create_card_note", "CreateCardNote", "library.write", "library", "Add a note to a card", {
    description:
      "Adds an empty note to a card, off in chats until switched on. With shared_note it shows that shared note's text. Write its text with edit_library_note.",
    parameters: Schema.Struct({ card: name, title: name, shared_note: optional(name) }),
    adapt: (args, ctx) =>
      Effect.gen(function* () {
        const card = yield* library(ctx, "card", args.card)
        if (args.shared_note === undefined) return { cardRefId: card.id, title: args.title }
        const shared = yield* libraryNote(ctx, args.shared_note)
        if (shared.owner.shared === undefined) return yield* fail("That note is not a shared note.")
        return { cardRefId: card.id, title: args.title, link: shared.ref.entityId }
      }),
    describe: (payload, ctx) =>
      ctx.reader.OpenEditor({ userId: ctx.userId, refId: payload.cardRefId as RefId }).pipe(
        Effect.map(({ ref }) => ({
          title: `Add the note “${String(payload.title)}” to the card “${ref.label}”`,
          rows: payload.link ? [{ label: "Shows", value: "The text of a shared note" }] : []
        }))
      ),
    summarize: (args) => String(args.title),
    render: (result) => JSON.stringify(savedRef(result as LibraryRef))
  }),
  exposure("create_shared_note", "CreateSharedNote", "library.write", "library", "Create a shared note", {
    description: "Creates a shared note: a named text that card and chat notes linked to it show.",
    parameters: Schema.Struct({ title: name, content: noteText }),
    describe: (payload) =>
      Effect.succeed({
        title: `Create the shared note “${String(payload.title)}”`,
        rows: [{ label: "Text", value: String(payload.content) }]
      }),
    summarize: (args) => String(args.title),
    render: (result) => JSON.stringify(savedRef(result as LibraryRef))
  }),
  exposure("create_chat_note", "CreateChatNote", "chats.setup", "setup", "Add a note to a chat", {
    description: "Adds a note to a chat. It is listed in every branch, and on only where change_chat switches it on.",
    parameters: Schema.Struct({ chat: name, title: name, content: optional(noteText) }),
    describe: (payload, ctx) =>
      Effect.succeed({
        title: `Add the note “${String(payload.title)}” to “${provedChat(ctx)}”`,
        rows: payload.content === undefined ? [] : [{ label: "Text", value: String(payload.content) }]
      }),
    adapt: (args, ctx) =>
      chatPayload(ctx, args).pipe(
        Effect.map(({ chatId, forkId }) => ({
          chatId,
          forkId,
          title: args.title,
          ...(args.content === undefined ? {} : { content: args.content })
        }))
      ),
    summarize: (args) => String(args.title),
    render: (result) => JSON.stringify(savedRef(result as LibraryRef))
  }),
  exposure("unlink_note", "UnlinkNote", "library.write", "library", "Unlink a card's note from its shared note", {
    description: "Gives a card's note that shows a shared note its own copy of the text. The shared note is kept.",
    parameters: Schema.Struct({ note: name }),
    adapt: (args, ctx) =>
      Effect.gen(function* () {
        const note = yield* libraryNote(ctx, args.note)
        if (note.owner.card === undefined || typeof note.saved.doc.link !== "string")
          return yield* fail("That note does not show a shared note.")
        return { noteRefId: note.ref.id }
      }),
    describe: (payload, ctx) =>
      ctx.reader
        .OpenEditor({ userId: ctx.userId, refId: payload.noteRefId as RefId })
        .pipe(Effect.map(({ ref }) => ({ title: `Unlink the note “${ref.label}” from its shared note`, rows: [] }))),
    summarize: (args) => String(args.note),
    render: (result) => JSON.stringify(savedRef(result as LibraryRef))
  }),
  exposure("delete_note", "DeleteNote", "library.write", "library", "Move a note to the bin", {
    description:
      "Moves a card's note or a shared note to the bin; notes showing a binned shared note send nothing. A chat's own notes are deleted in that chat.",
    parameters: Schema.Struct({ note: name }),
    adapt: (args, ctx) => libraryNote(ctx, args.note).pipe(Effect.map((note) => ({ noteRefId: note.ref.id }))),
    describe: (payload, ctx) =>
      Effect.gen(function* () {
        const { ref } = yield* ctx.reader.OpenEditor({ userId: ctx.userId, refId: payload.noteRefId as RefId })
        // A shared note's text leaves every note that shows it until it's taken back out.
        const [shared] = yield* ctx.reader.ListSharedNotes({ userId: ctx.userId, refId: ref.id })
        return {
          title: `Move the note “${ref.label}” to the bin`,
          rows:
            shared && shared.usedBy > 0
              ? [{ label: "Shown by", value: shared.usedBy === 1 ? "1 note" : `${shared.usedBy} notes` }]
              : []
        }
      }),
    summarize: (args) => String(args.note),
    render: () => JSON.stringify({ inBin: true })
  }),
  exposure("set_persona", "SetPersona", "library.write", "library", "Mark a card as a persona, or not", {
    description: "Sets whether a card is one of the user's personas (a card they play as). Its text is unchanged.",
    parameters: Schema.Struct({ card: name, persona: Schema.Boolean }),
    adapt: (args, ctx) =>
      library(ctx, "card", args.card).pipe(Effect.map((ref) => ({ entityId: ref.entityId, persona: args.persona }))),
    describe: (payload, ctx) =>
      ctx.reader.CastCards({ userId: ctx.userId, entityIds: [payload.entityId as EntityId] }).pipe(
        Effect.map(([card]) => ({
          title: `${payload.persona ? "Make" : "Stop making"} “${card?.name ?? "this card"}” a persona`,
          rows: []
        }))
      ),
    summarize: (args) => String(args.card),
    render: (_result, args) => JSON.stringify({ persona: args.persona })
  }),
  // --- Files (ARCHITECTURE.md §11.4, §13).
  exposure("list_export_formats", "ListExportFormats", "library.read", "read", "List export formats", {
    label: "Looked up export formats",
    description:
      "Lists the file formats cards, presets and lorebooks export to. The user downloads exports from the library.",
    parameters: Schema.Struct({}),
    adapt: () => Effect.succeed(undefined),
    describe: () => Effect.succeed({ title: "List export formats", rows: [] }),
    render: (result) =>
      JSON.stringify({
        formats: (result as ReadonlyArray<typeof ExportFormatInfo.Type>).map((format) => ({
          format: format.id,
          kind: format.kind,
          label: format.label,
          extension: format.extension,
          holds: format.media,
          ...(format.description ? { description: format.description } : {})
        }))
      })
  }),
  {
    ...exposure("import_library_file", "ImportFile", "library.write", "library", "Import a file into your library"),
    operation: { command: "library.import" },
    description:
      "Imports one card, preset or lorebook from a JSON file's text as a new library entry. Fetches nothing; its scripts and HTML stay off until the user allows them. Files with pictures are imported from the library page.",
    parameters: Schema.Struct({
      name: name.annotate({ description: "The file's name, with its extension: mira.json." }),
      content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000))
    }),
    describe: (payload) =>
      Effect.succeed({
        title: `Import the file “${String(payload.name)}”`,
        rows: [
          { label: "File text", value: String(payload.content) },
          { label: "Executable content", value: executableNotice }
        ]
      }),
    summarize: (args) => String(args.name),
    render: (result) => {
      const done = result as {
        report: { format: string | null; issues: ReadonlyArray<{ level: string; message: string }> }
        library: { ref: LibraryRef; note: LibraryRef | null } | null
      }
      return JSON.stringify({
        ...(done.library ? savedRef(done.library.ref) : { imported: false }),
        ...(done.library?.note ? { note: done.library.note.id } : {}),
        format: done.report.format,
        issues: done.report.issues.slice(0, 20).map((issue) => ({ level: issue.level, message: issue.message }))
      })
    }
  },
  exposure("list_imports", "ListStImports", "chats.read", "read", "List your folder imports", {
    label: "Looked at your folder imports",
    description:
      "Lists folder imports: status, progress and counts. Read one's report with read_import. Imports are started and stopped on the import page.",
    parameters: Schema.Struct(pageArgs),
    adapt: (_args, ctx) => checkStoryReadScope(ctx).pipe(Effect.as(undefined)),
    describe: () => Effect.succeed({ title: "List your folder imports", rows: [] }),
    summarize: () => "imports",
    render: (result, args) =>
      JSON.stringify(
        paged(
          (result as ReadonlyArray<StImportJob>).map((job) => ({
            id: job.id,
            status: job.status,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            filesDone: job.filesDone,
            filesTotal: job.filesTotal,
            counts: job.counts,
            attention: job.attention,
            failed: job.error !== null
          })),
          args
        )
      )
  }),
  exposure("read_import", "GetStImportReport", "chats.read", "read", "Read a folder import's report", {
    label: "Read an import's report",
    description: "Reads a folder import's report: counts by kind, and its issues paged with offset.",
    parameters: Schema.Struct({ import: name, ...pageArgs }),
    adapt: (args, ctx) => checkStoryReadScope(ctx).pipe(Effect.as({ importId: args.import })),
    describe: () => Effect.succeed({ title: "Read a folder import's report", rows: [] }),
    summarize: () => "import report",
    render: (result, args) => {
      const report = result as StImportReport
      return JSON.stringify({
        counts: report.counts,
        messages: report.messages,
        summaries: report.summaries,
        greetingOnly: report.greetingOnly,
        unsupported: report.unsupported,
        chatsToLink: report.links.length,
        hiddenRuns: report.hiddenRuns.length,
        dropped: report.dropped,
        ...paged(
          report.issues.map((issue) => ({
            level: issue.level,
            code: issue.code,
            file: issue.path,
            message: issue.message
          })),
          args
        )
      })
    }
  }),
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
          const reply = result as {
            _tag: string
            entry?: { version: { id: import("@dreamspan/shared/chat.ts").VersionId } }
          }
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
