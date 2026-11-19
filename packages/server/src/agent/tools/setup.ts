import { editDocument, presetEditArguments, lorebookEditArguments } from "./documents.ts"
import { toolResultFrame } from "../toolData.ts"
import { boundedArguments } from "../operations.ts"
import { documentDiff, documentChangeRows, executableNotice } from "../../db/agentDocuments.ts"
import { ToolInputRefused } from "../tools.ts"
import { LibraryLabel } from "@dreamspan/shared/editorApi.ts"
import { offeredGreetings } from "@dreamspan/shared/greetings.ts"
import { freezeTemplate } from "../../chat/macros.ts"
import { Type, validateToolArguments, type ToolCall } from "@earendil-works/pi-ai"
import { newCardDoc } from "@dreamspan/shared/editing.ts"
import { Effect, Schema } from "effect"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { ModelId } from "@dreamspan/shared/providers.ts"
import type { LibraryRef } from "@dreamspan/shared/library.ts"
import type { RolloutTool, ToolContext, ToolOutput } from "../tools.ts"
import { resolveLibrary } from "./library.ts"
import { workshopLimits as limits } from "../../workshopLimits.ts"

const receiptFirst = <A>(tool: RolloutTool<A>): RolloutTool<A> => ({
  ...tool,
  execute: (ctx, args) =>
    safely(
      ctx.reader.RolloutToolReceipt(key(ctx)).pipe(
        Effect.flatMap((receipt) =>
          receipt === null
            ? Effect.try({
                try: () => {
                  if (!boundedArguments(args)) throw new Error("Arguments exceed the size limits.")
                  return validateToolArguments(
                    { name: tool.id, description: tool.description, parameters: tool.parameters },
                    { type: "toolCall", id: ctx.toolCallId, name: tool.id, arguments: args as ToolCall["arguments"] }
                  ) as A
                },
                catch: () => ({
                  message: "Invalid tool arguments. Use only the listed fields and stay within their size limits."
                })
              }).pipe(
                Effect.flatMap((validated) => tool.execute(ctx, validated)),
                Effect.map((out) =>
                  !ctx.formatResult || out.isError ? out : { ...out, frame: toolResultFrame(JSON.parse(out.text)) }
                )
              )
            : Effect.succeed(receipt.isError ? receipt : { text: receipt.text })
        )
      )
    )
})
const targetKey = (ctx: ToolContext) => `approval:targets:${ctx.toolCallId}`
const targets = (ctx: ToolContext) => ctx.cache.get(targetKey(ctx)) as Map<string, LibraryRef> | undefined
const remember = (ctx: ToolContext, kind: string, name: string, ref: LibraryRef) => {
  const refs = targets(ctx) ?? new Map<string, LibraryRef>()
  refs.set(`${kind}:${name}`, ref)
  ctx.cache.set(targetKey(ctx), refs)
}
const key = (ctx: ToolContext) => ({
  userId: ctx.userId,
  rolloutId: ctx.rolloutId,
  toolCallId: ctx.toolCallId,
  ...(ctx.approvalDigest ? { approvalDigest: ctx.approvalDigest } : {}),
  ...(targets(ctx)
    ? {
        expectedRefs: [...targets(ctx)!.values()].map((ref) => ({
          refId: ref.id,
          rowVersion: ref.rowVersion,
          archivedAt: ref.archivedAt ?? null
        }))
      }
    : {})
})
const safely = <E>(body: Effect.Effect<ToolOutput, E>) =>
  body.pipe(
    Effect.catch((error) => {
      const failure = error as { _tag?: string; message?: string; reason?: string; problems?: ReadonlyArray<string> }
      const text =
        failure._tag === "StorageError" || failure._tag === "RpcClientError"
          ? "The change could not be saved. Try again."
          : failure._tag === "StaleWrite"
            ? "The saved item changed. Read it again before editing."
            : failure._tag === "NotFound"
              ? "That item is unavailable in your library."
              : (failure.problems?.join("; ") ?? failure.reason ?? failure.message ?? "The change could not be saved.")
      return Effect.succeed({ text, isError: true })
    })
  )
const findRef = (ctx: ToolContext, kind: "card" | "preset" | "lorebook", name: string) =>
  targets(ctx)?.has(`${kind}:${name}`)
    ? Effect.succeed(targets(ctx)!.get(`${kind}:${name}`)!)
    : resolveLibrary(ctx, kind, name).pipe(
        Effect.flatMap((found) =>
          "error" in found ? Effect.fail({ message: found.error }) : Effect.succeed(found.ref)
        )
      )
/** A value as the approval shows it: the text as given, a list one item a line. */
const shown = (value: unknown) =>
  typeof value === "string" ? value : Array.isArray(value) ? value.map(String).join("\n") : JSON.stringify(value)
/** The fields an approval lists: those the call sets, labelled as the arguments name them. */
const rowsOf = (args: object, skip: ReadonlyArray<string> = []) =>
  Object.entries(args)
    .filter(([key, value]) => !skip.includes(key) && value !== undefined && value !== "")
    .map(([label, value]) => ({ label: label.replaceAll("_", " "), value: shown(value) }))
/** A name as the library has it, or the name asked for when nothing matches. */
const realName = (ctx: ToolContext, kind: "card" | "preset" | "lorebook", name: string) =>
  resolveLibrary(ctx, kind, name).pipe(
    Effect.flatMap((found) =>
      "error" in found
        ? Effect.fail(new Error(found.error))
        : Effect.sync(() => {
            remember(ctx, kind, name, found.ref)
            return found.ref.label
          })
    )
  )
const text = Type.String({ maxLength: limits.textChars })
const name = Type.String({ minLength: 1, maxLength: limits.nameChars })
const shortText = Type.String({ maxLength: limits.nameChars })
const strict = { additionalProperties: false } as const
const cardFields = {
  nickname: Type.Optional(shortText),
  description: Type.Optional(text),
  personality: Type.Optional(text),
  scenario: Type.Optional(text),
  first_message: Type.Optional(text),
  alternate_greetings: Type.Optional(Type.Array(text, { maxItems: limits.listItems })),
  example_messages: Type.Optional(text),
  system_prompt: Type.Optional(text),
  tags: Type.Optional(Type.Array(name, { maxItems: limits.listItems })),
  persona: Type.Optional(Type.Boolean())
}
interface CreateArgs {
  readonly name: string
  readonly nickname?: string
  readonly description?: string
  readonly personality?: string
  readonly scenario?: string
  readonly first_message?: string
  readonly alternate_greetings?: ReadonlyArray<string>
  readonly example_messages?: string
  readonly system_prompt?: string
  readonly tags?: ReadonlyArray<string>
  readonly persona?: boolean
}
const createCard: RolloutTool<CreateArgs> = {
  source: import.meta.url,
  id: "create_card",
  storyRead: "library",
  label: "Created the card",
  titleField: "name",
  explanation: "Create an ordinary card in your library.",
  effect: "library",
  capability: "library.write",
  description:
    "Creates a card in the library, with one agent revision. Use first_message for her greeting. Returns its library and entity ids. Undo moves it to the bin if untouched.",
  parameters: Type.Object({ name, ...cardFields }, strict),
  summarize: ({ name }) => name,
  describe: (_ctx, args) => Effect.succeed({ title: `Create the card “${args.name}”`, rows: rowsOf(args, ["name"]) }),
  execute: (ctx, args) =>
    !Schema.is(LibraryLabel)(args.name)
      ? Effect.succeed({
          text: "Give the card a name of 1 to 200 characters, without control characters or surrounding spaces.",
          isError: true
        })
      : safely(
          ctx.writer
            .AgentCreateEntity({
              ...key(ctx),
              kind: "card",
              label: args.name,
              doc: {
                ...newCardDoc(args.name),
                nickname: args.nickname ?? "",
                description: args.description ?? "",
                personality: args.personality ?? "",
                scenario: args.scenario ?? "",
                first_mes: args.first_message ?? "",
                alternate_greetings: args.alternate_greetings ?? [],
                mes_example: args.example_messages ?? "",
                system_prompt: args.system_prompt ?? "",
                tags: args.tags ?? []
              },
              tags: [...new Set([...(args.tags ?? []), ...(args.persona ? ["persona"] : [])])]
            })
            .pipe(Effect.map((text) => ({ text })))
        )
}
const fields = [
  "name",
  "nickname",
  "character_version",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "system_prompt",
  "post_history_instructions",
  "creator_notes",
  "creator"
]
type CardChanges = ReadonlyArray<{
  readonly field: string
  readonly text?: string
  readonly find?: string
  readonly replace?: string
  readonly items?: ReadonlyArray<string>
}>
/** The other greetings, as one text an approval can show before and after. */
const greetingsShown = (value: unknown) => (Array.isArray(value) ? value.map(String).join("\n\n---\n\n") : "")
/** A card's saved document with the changes made, or why they can't be. */
const changed = (saved: Record<string, unknown>, changes: CardChanges) => {
  const doc = { ...saved }
  for (const change of changes) {
    const field =
      ({ first_message: "first_mes", example_messages: "mes_example" } as Record<string, string>)[change.field] ??
      change.field
    if (change.items !== undefined) {
      if (field !== "alternate_greetings") return { error: "Only alternate_greetings takes a list of items." }
      doc[field] = [...change.items]
      continue
    }
    if (!fields.includes(field)) return { error: `The text field ${change.field} cannot be edited by this tool.` }
    if (change.text !== undefined) doc[field] = change.text
    else {
      const current = String(doc[field] ?? "")
      if (!change.find || current.split(change.find).length !== 2)
        return { error: `Find must occur exactly once in ${field}. Read the card again.` }
      doc[field] = current.replace(change.find, () => change.replace ?? "")
    }
  }
  return { doc }
}
const editCard: RolloutTool<{
  readonly card: string
  readonly changes: CardChanges
}> = {
  source: import.meta.url,
  id: "edit_card",
  storyRead: "library",
  label: "Edited the card",
  titleField: "card",
  explanation: "Edit the saved library card, leaving drafts and history intact.",
  effect: "library",
  capability: "library.write",
  description:
    "Edits a library card by name or id. Each change replaces a whole text field with text, or one exact find with replace, or sets alternate_greetings to a whole list with items. A find must occur exactly once. All changes save together on the head read; a moved head is an error. Does not grant permissions or approvals. Unsaved drafts remain unsaved.",
  parameters: Type.Object(
    {
      card: name,
      changes: Type.Array(
        Type.Union([
          Type.Object({ field: name, text }, strict),
          Type.Object(
            { field: name, find: Type.String({ minLength: 1, maxLength: limits.textChars }), replace: text },
            strict
          ),
          Type.Object(
            { field: Type.Literal("alternate_greetings"), items: Type.Array(text, { maxItems: limits.listItems }) },
            strict
          )
        ]),
        { minItems: 1, maxItems: limits.listItems }
      )
    },
    strict
  ),
  summarize: ({ card }) => card,
  // The saved card's fields as they are and as the edit would leave them.
  describe: (ctx, args) =>
    Effect.gen(function* () {
      const found = yield* resolveLibrary(ctx, "card", args.card)
      if ("error" in found) return yield* Effect.fail(new Error(found.error))
      remember(ctx, "card", args.card, found.ref)
      const saved = yield* ctx.reader.OpenEditor({ userId: ctx.userId, refId: found.ref.id })
      ctx.cache.set(`approval:edit:${ctx.toolCallId}`, saved)
      const result = changed(saved.doc, args.changes)
      const title = `Edit the card “${found.ref.label}”`
      if ("error" in result) return { title, rows: [{ label: "changes", value: result.error }] }
      const changes = Object.keys(result.doc)
        .filter((field) => fields.includes(field) && String(saved.doc[field] ?? "") !== String(result.doc[field] ?? ""))
        .map((field) => ({ field, before: String(saved.doc[field] ?? ""), after: String(result.doc[field] ?? "") }))
      const greetings = [greetingsShown(saved.doc.alternate_greetings), greetingsShown(result.doc.alternate_greetings)]
      if (greetings[0] !== greetings[1])
        changes.push({ field: "alternate_greetings", before: greetings[0]!, after: greetings[1]! })
      return { title, rows: [], changes }
    }),
  execute: (ctx, args) =>
    safely(
      Effect.gen(function* () {
        const ref = yield* findRef(ctx, "card", args.card)
        const saved =
          (ctx.cache.get(`approval:edit:${ctx.toolCallId}`) as
            Effect.Success<ReturnType<ToolContext["reader"]["OpenEditor"]>> | undefined) ??
          (yield* ctx.reader.OpenEditor({ userId: ctx.userId, refId: ref.id }))
        const result = changed(saved.doc, args.changes)
        if ("error" in result) return { text: result.error, isError: true }
        const doc = result.doc
        const text = yield* ctx.writer.AgentReviseEntity({
          ...key(ctx),
          refId: ref.id,
          expectedRowVersion: saved.ref.rowVersion,
          doc
        })
        return { text }
      })
    )
}
const cloneCard: RolloutTool<{
  readonly card: string
  readonly name: string
  readonly nickname?: string
  readonly version?: string
}> = {
  source: import.meta.url,
  id: "clone_card",
  storyRead: "library",
  label: "Cloned the card",
  titleField: "name",
  explanation: "Fork a card into an ordinary card of its own.",
  effect: "library",
  capability: "library.write",
  description:
    "Clones a card through the library's ForkCard operation, including its notes and draft handling. Name and version must distinguish it. Returns the new card's ids.",
  parameters: Type.Object(
    {
      card: name,
      name,
      nickname: Type.Optional(shortText),
      version: Type.Optional(shortText)
    },
    strict
  ),
  summarize: ({ name }) => name,
  describe: (ctx, args) =>
    Effect.map(realName(ctx, "card", args.card), (source) => ({
      title: `Copy the card “${source}” as “${args.name}”`,
      rows: rowsOf(args, ["card", "name"])
    })),
  execute: (ctx, args) =>
    safely(
      Effect.gen(function* () {
        const ref = yield* findRef(ctx, "card", args.card)
        const text = yield* ctx.writer.AgentCloneCard({
          ...key(ctx),
          refId: ref.id,
          name: args.name,
          nickname: args.nickname ?? "",
          characterVersion: args.version ?? ""
        })
        return { text }
      })
    )
}
const startChat: RolloutTool<{
  readonly cards: ReadonlyArray<string>
  readonly persona?: string
  readonly greeting?: number
  readonly title?: string
  readonly preset?: string
  readonly model?: string
}> = {
  source: import.meta.url,
  id: "start_chat",
  storyRead: "library",
  label: "Started the chat",
  titleField: "title",
  explanation: "Set up a story chat with greetings, without requesting a reply.",
  effect: "setup",
  capability: "chats.setup",
  description:
    "Starts a story chat with library cards (names or ids), an optional persona, greeting index (0 is the first), title, preset name/id and model id. Posts only card greetings; never sends a provider request. Returns chatId.",
  parameters: Type.Object(
    {
      cards: Type.Array(name, { minItems: 1, maxItems: limits.castCards }),
      persona: Type.Optional(name),
      greeting: Type.Optional(Type.Integer({ minimum: 0 })),
      title: Type.Optional(shortText),
      preset: Type.Optional(name),
      model: Type.Optional(name)
    },
    strict
  ),
  summarize: ({ title, cards }) => title ?? cards.join(", "),
  describe: (ctx, args) =>
    Effect.gen(function* () {
      const cards: Array<string> = []
      for (const card of args.cards) cards.push(yield* realName(ctx, "card", card))
      return {
        title: args.title ? `Start the chat “${args.title}”` : "Start a chat",
        rows: [
          { label: "cards", value: cards.join("\n") },
          ...(args.persona ? [{ label: "persona", value: yield* realName(ctx, "card", args.persona) }] : []),
          ...(args.preset ? [{ label: "preset", value: yield* realName(ctx, "preset", args.preset) }] : []),
          ...rowsOf(args, ["cards", "persona", "preset", "title"])
        ]
      }
    }),
  execute: (ctx, args) =>
    safely(
      Effect.gen(function* () {
        const cards: Array<EntityId> = []
        for (const name of args.cards) {
          const ref = yield* findRef(ctx, "card", name)
          if (!cards.includes(ref.entityId)) cards.push(ref.entityId)
        }
        const persona = args.persona ? (yield* findRef(ctx, "card", args.persona)).entityId : null
        const [player] =
          persona === null ? [] : yield* ctx.reader.CastCards({ userId: ctx.userId, entityIds: [persona] })
        const greeters = []
        for (const entityId of cards) {
          const card = yield* ctx.reader.GetCardForChat({ userId: ctx.userId, entityId })
          const options = offeredGreetings(card, cards.filter((id) => id !== persona).length)
          const picked = args.greeting ?? options[0]?.index ?? 0
          if (args.greeting !== undefined && !options.some((o) => o.index === picked))
            return { text: "That greeting is not available. Read the card again.", isError: true }
          const fields = { description: card.description, personality: card.personality, scenario: card.scenario }
          const names = {
            user: player?.modelName ?? player?.name ?? "User",
            char: card.card.modelName ?? card.card.name
          }
          greeters.push({
            entityId,
            greeting: picked,
            options: options.map((option) => ({
              index: option.index,
              text: option.text,
              frozen: freezeTemplate(option.text, fields, names, {})
            }))
          })
        }
        const preset = args.preset ? (yield* findRef(ctx, "preset", args.preset)).id : null
        const text = yield* ctx.writer.AgentStartChat({
          ...key(ctx),
          cards,
          persona,
          greeters,
          title: args.title ?? null,
          preset,
          model: (args.model as ModelId | undefined) ?? null
        })
        return { text }
      })
    )
}
/** Both tools keep the exact saved snapshot the server showed while asking. */
const editLibraryDocument = (kind: "preset" | "lorebook", schema: Schema.Top): RolloutTool<Record<string, unknown>> => {
  const json = Schema.toJsonSchemaDocument(schema)
  const parameters = {
    ...json.schema,
    $defs: json.definitions,
    additionalProperties: false
  } as RolloutTool<never>["parameters"]
  const prepare = (ctx: ToolContext, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      if (!boundedArguments(args)) return yield* Effect.fail(new Error("Arguments exceed this tool's size limits."))
      yield* Effect.try({
        try: () =>
          validateToolArguments(
            { name: `edit_${kind}`, description: "Edit a document", parameters },
            { type: "toolCall", id: ctx.toolCallId, name: `edit_${kind}`, arguments: args as never }
          ),
        catch: () => new Error("Invalid tool arguments. Use only the listed fields and stay within their size limits.")
      })
      yield* Schema.decodeUnknownEffect(schema as Schema.Codec<unknown, unknown>)(args, { onExcessProperty: "error" })
      const ref = yield* findRef(ctx, kind, String(args[kind]))
      const saved = yield* ctx.reader.OpenEditor({ userId: ctx.userId, refId: ref.id })
      if (saved.ref.kind !== kind) return yield* Effect.fail(new Error("The saved item has another document type."))
      const doc = yield* Effect.try({
        try: () => editDocument(kind, saved.doc, args.changes as readonly Record<string, unknown>[]),
        catch: (error) => error as Error
      })
      const attachments: Array<{ label: string; value: string }> = []
      if (kind === "preset")
        for (const book of (doc.lorebooks ?? []) as ReadonlyArray<{ id: string; enabled: boolean }>) {
          const linked = yield* ctx.reader.OpenEditor({ userId: ctx.userId, refId: book.id as LibraryRef["id"] })
          if (linked.ref.kind !== "lorebook") return yield* Effect.fail(new Error("That attachment is not a lorebook."))
          // A linked book can change the prompt too. Keep its owned head pinned with the preset.
          if (!targets(ctx)?.has(`lorebook:${book.id}`)) remember(ctx, "lorebook", book.id, linked.ref)
          attachments.push({
            label: `Lorebook ${linked.ref.label} (${book.id})`,
            value: `${book.enabled ? "On" : "Off"}; ${(linked.doc.entries as readonly unknown[]).length} entries`
          })
        }
      return { saved, doc, attachments }
    })
  return {
    source: import.meta.url,
    id: `edit_${kind}`,
    storyRead: "library",
    label: `Edited the ${kind}`,
    titleField: kind,
    explanation: `Edit a saved ${kind}, keeping unsaved drafts and history.`,
    effect: "library",
    capability: "library.write",
    description: `Edits one saved ${kind} by name or id, atomically. Read it first. ${kind === "preset" ? "Use prompt identifiers. text or find/replace edits content; enabled switches it; before moves it (null means last); set changes prompt fields; add adds a prompt; remove deletes one (never Main). settings changes document-owned settings, regex or attachments." : "Use entry uids. text or find/replace edits content; enabled switches it; before moves it (null means last); set changes any entry fields; add adds an entry with the editor defaults; remove deletes one. settings changes book settings."} A find must occur exactly once. Changed regex and HTML stays disabled/unapproved for the user. Drafts are never overwritten. Undo restores the previous saved document if untouched.`,
    parameters,
    summarize: (args) => String(args[kind]),
    describe: (ctx, args) =>
      prepare(ctx, args).pipe(
        Effect.map(({ saved, doc, attachments }) => {
          remember(ctx, kind, String(args[kind]), saved.ref)
          ctx.cache.set(`approval:document:${ctx.toolCallId}`, { saved, doc })
          return {
            title: `Edit the ${kind} “${saved.ref.label}”`,
            rows: [
              ...documentChangeRows(documentDiff(saved.doc, doc)),
              ...attachments,
              { label: "Executable content", value: executableNotice }
            ],
            changes: documentDiff(saved.doc, doc)
          }
        }),
        Effect.mapError(
          (error) =>
            new ToolInputRefused(
              error instanceof Error ? error.message : "This document change is invalid. Read it again."
            )
        )
      ),
    execute: (ctx, args) =>
      safely(
        Effect.gen(function* () {
          // Validate again on direct or resumed invocation; the write still uses the pinned snapshot.
          const fresh = yield* prepare(ctx, args)
          const cached = ctx.cache.get(`approval:document:${ctx.toolCallId}`) as typeof fresh | undefined
          const { saved, doc } = cached ?? fresh
          const text = yield* ctx.writer.AgentReviseEntity({
            ...key(ctx),
            refId: saved.ref.id,
            expectedRowVersion: saved.ref.rowVersion,
            doc
          })
          return { text }
        })
      )
  }
}
type CardNoteEdit = { readonly card: string; readonly note: string; readonly content: string }
const prepareCardNote = (ctx: ToolContext, args: CardNoteEdit) =>
  Effect.gen(function* () {
    const ref = yield* findRef(ctx, "card", args.card)
    remember(ctx, "card", args.card, ref)
    const notes = yield* ctx.reader.ListCardNotes({ userId: ctx.userId, cardRefId: ref.id })
    const matches = notes.filter(
      (note) =>
        note.ref.id === args.note ||
        String(note.doc.title ?? note.ref.label).toLocaleLowerCase() === args.note.toLocaleLowerCase()
    )
    if (matches.length !== 1) return yield* Effect.fail(new ToolInputRefused("Choose one note id from read_card."))
    const saved = yield* ctx.reader.OpenEditor({ userId: ctx.userId, refId: matches[0]!.ref.id })
    if (saved.doc.link)
      return yield* Effect.fail(
        new ToolInputRefused("This note shows shared text. Edit the shared note in its editor.")
      )
    remember(ctx, "note", args.note, saved.ref)
    return saved
  })
const editCardNote: RolloutTool<CardNoteEdit> = {
  source: import.meta.url,
  id: "edit_card_note",
  // A saved card note in the library, like edit_card: no story position (merge-batch10).
  storyRead: "library",
  label: "Edited a card note",
  explanation: "Edit a saved card note’s text with Undo.",
  effect: "library",
  capability: "library.write",
  description:
    "Edits the saved text of one card note, including its own-turn framing. Read the card first for note names and ids. Conditions, placement and replacement targets are kept. Unsaved drafts remain unsaved.",
  parameters: Type.Object({ card: name, note: name, content: text }, strict),
  summarize: ({ card, note }) => `${card}: ${note}`,
  describe: (ctx, args) =>
    Effect.gen(function* () {
      const saved = yield* prepareCardNote(ctx, args)
      ctx.cache.set(`approval:card-note:${ctx.toolCallId}`, saved)
      return {
        title: `Edit the note “${saved.ref.label}”`,
        rows: [],
        changes: [{ field: "Text", before: String(saved.doc.content ?? ""), after: args.content }]
      }
    }),
  execute: (ctx, args) =>
    safely(
      Effect.gen(function* () {
        const saved =
          (ctx.cache.get(`approval:card-note:${ctx.toolCallId}`) as
            Effect.Success<ReturnType<typeof prepareCardNote>> | undefined) ?? (yield* prepareCardNote(ctx, args))
        return {
          text: yield* ctx.writer.AgentReviseEntity({
            ...key(ctx),
            refId: saved.ref.id,
            expectedRowVersion: saved.ref.rowVersion,
            doc: { ...saved.doc, content: args.content }
          })
        }
      })
    )
}
type LibraryNoteEdit = { readonly note: string; readonly content?: string; readonly on_by_default?: boolean }
const prepareLibraryNote = (ctx: ToolContext, args: LibraryNoteEdit) =>
  Effect.gen(function* () {
    if (args.content === undefined && args.on_by_default === undefined)
      return yield* Effect.fail(new ToolInputRefused("Give the note's new text, or whether it is on by default."))
    const pinned = targets(ctx)?.get(`note:${args.note}`)
    const found = pinned ? { ref: pinned } : yield* resolveLibrary(ctx, "note", args.note)
    if ("error" in found) return yield* Effect.fail(new ToolInputRefused(found.error))
    const saved = yield* ctx.reader.OpenEditor({ userId: ctx.userId, refId: found.ref.id })
    const owner = (saved.doc.owner ?? {}) as { readonly card?: string; readonly chat?: string }
    if (saved.ref.kind !== "note" || owner.chat !== undefined)
      return yield* Effect.fail(
        new ToolInputRefused("That note belongs to one chat. Change it in the chat's Notes, on the branch it is for.")
      )
    if (args.content !== undefined && saved.doc.link)
      return yield* Effect.fail(
        new ToolInputRefused("This note shows a shared note's text. Edit the shared note, or unlink this one first.")
      )
    if (args.on_by_default !== undefined && owner.card === undefined)
      return yield* Effect.fail(new ToolInputRefused("Only a card's note is on or off by default."))
    remember(ctx, "note", args.note, saved.ref)
    return {
      saved,
      doc: {
        ...saved.doc,
        ...(args.content === undefined ? {} : { content: args.content }),
        ...(args.on_by_default === undefined ? {} : { on_by_default: args.on_by_default })
      }
    }
  })
const editLibraryNote: RolloutTool<LibraryNoteEdit> = {
  source: import.meta.url,
  id: "edit_library_note",
  // The workshop's only: never one of a story's reply tools.
  replyTool: false,
  storyRead: "library",
  label: "Edited a note",
  titleField: "note",
  explanation: "Edit a shared note or a card's note, with Undo.",
  effect: "library",
  capability: "library.write",
  description:
    "Edits a shared note's or a card note's text, or whether a card's note is on by default in chats. Read it first; placement and conditions are kept. A chat's own notes are changed in that chat.",
  parameters: Type.Object(
    { note: name, content: Type.Optional(text), on_by_default: Type.Optional(Type.Boolean()) },
    strict
  ),
  summarize: ({ note }) => note,
  describe: (ctx, args) =>
    Effect.gen(function* () {
      const prepared = yield* prepareLibraryNote(ctx, args)
      ctx.cache.set(`approval:library-note:${ctx.toolCallId}`, prepared)
      return {
        title: `Edit the note “${prepared.saved.ref.label}”`,
        rows:
          args.on_by_default === undefined
            ? []
            : [{ label: "On by default in chats", value: args.on_by_default ? "Yes" : "No" }],
        ...(args.content === undefined
          ? {}
          : { changes: [{ field: "Text", before: String(prepared.saved.doc.content ?? ""), after: args.content }] })
      }
    }),
  execute: (ctx, args) =>
    safely(
      Effect.gen(function* () {
        const prepared =
          (ctx.cache.get(`approval:library-note:${ctx.toolCallId}`) as
            Effect.Success<ReturnType<typeof prepareLibraryNote>> | undefined) ?? (yield* prepareLibraryNote(ctx, args))
        return {
          text: yield* ctx.writer.AgentReviseEntity({
            ...key(ctx),
            refId: prepared.saved.ref.id,
            expectedRowVersion: prepared.saved.ref.rowVersion,
            doc: prepared.doc
          })
        }
      })
    )
}
export const libraryEditCard = receiptFirst(editCard)
export const setupTools: ReadonlyArray<RolloutTool<never>> = [
  receiptFirst(editCardNote),
  receiptFirst(editLibraryNote),
  receiptFirst(createCard),
  receiptFirst(cloneCard),
  receiptFirst(startChat),
  receiptFirst(editLibraryDocument("preset", presetEditArguments)),
  receiptFirst(editLibraryDocument("lorebook", lorebookEditArguments))
]
