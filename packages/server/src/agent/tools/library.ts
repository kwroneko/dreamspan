import { toolResultFrame } from "../toolData.ts"
/** Library heads and attached revisions, scoped to the rollout's owner. */
import {
  CARD_TEXT_FIELDS,
  type CountEffect,
  estimateCount,
  findPart,
  indexLines,
  inlineLimit,
  pageOf,
  pageTokens,
  summaryLines,
  visibleDoc,
  withCounts
} from "../libraryView.ts"
import { withoutCardSkills } from "../toolLoading.ts"
import { Type } from "@earendil-works/pi-ai"
import type { EntityKind, LibraryRef, RefId, RevisionId } from "@dreamspan/shared/library.ts"
import { Effect } from "effect"
import type { RolloutTool, ToolContext } from "../tools.ts"
import { classOfKind, libraryClassIds } from "../capabilities.ts"

const failRead = (error: unknown) =>
  Effect.logWarning("Workshop library read failed", error).pipe(
    Effect.as({ text: "The library entry could not be read. Check its name or id and try again.", isError: true })
  )

const entries = (context: ToolContext, kind: EntityKind, archived = false) =>
  context.reader.ListLibrary({ userId: context.userId, kind, tag: null, archived, withFilterData: true })

const kindNoun: Record<EntityKind, string> = {
  card: "card",
  lorebook: "lorebook",
  preset: "preset",
  note: "note",
  preset_overlay: "preset overlay"
}

/**
 * A library item by name, library id or entity id, through what the reply may see
 * (spec/WORKSHOP-CARDS.md §2): an item in view resolves without asking; anything else, a miss or
 * an ambiguous name included, asks the kind's class first, so no name outside view is told
 * before the user allows it. Every library tool, setup tool and version tool resolves here.
 */
export const resolveLibrary = (context: ToolContext, kind: EntityKind, name: string) =>
  Effect.gen(function* () {
    const refs = [...(yield* entries(context, kind)), ...(yield* entries(context, kind, true))]
    const id = refs.find((ref) => ref.id === name || ref.entityId === name)
    const matches = id ? [id] : refs.filter((ref) => ref.label.toLocaleLowerCase() === name.toLocaleLowerCase())
    if (context.sight) {
      const sight = context.sight
      const seen = yield* Effect.filter(matches, (ref) => sight.inView(ref.entityId))
      if (seen.length === 1) return { ref: seen[0]! }
      const shown = matches.length === 1 ? matches[0]!.label : name
      const allowed = yield* sight.gate(classOfKind(kind), `It wants to open the ${kindNoun[kind]} “${shown}”.`)
      if (!allowed.ok) return { error: allowed.text }
    }
    return matches.length === 1
      ? { ref: matches[0]! }
      : {
          error:
            matches.length === 0
              ? `No ${kind} matches ${JSON.stringify(name)}. Candidates: ${JSON.stringify(refs.slice(0, 5).map(identity))}. Use list_library to find it.`
              : `Several entries match ${JSON.stringify(name)}. Choose an id: ${JSON.stringify(matches.map(identity))}`
        }
  })

const identity = (ref: LibraryRef) => ({
  id: ref.id,
  entityId: ref.entityId,
  name: ref.label,
  subtitle: ref.subtitle,
  tags: ref.filterData?.tags ?? []
})

const listLibrary: RolloutTool<{
  readonly kind: "card" | "preset" | "lorebook" | "note"
  readonly query?: string
  readonly limit?: number
}> = {
  source: import.meta.url,
  id: "list_library",
  storyRead: "library",
  label: "Looked in your library",
  explanation: "Find cards, presets, lorebooks and notes in your library.",
  effect: "read",
  gatedBy: libraryClassIds,
  description: "Lists your library entries with names, ids, subtitles and tags. Use an id when names are ambiguous.",
  parameters: Type.Object({
    kind: Type.Union([Type.Literal("card"), Type.Literal("preset"), Type.Literal("lorebook"), Type.Literal("note")]),
    query: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
  }),
  summarize: ({ query, kind }) => query ?? kind,
  execute: (context, { kind, query, limit }) =>
    Effect.gen(function* () {
      const refused = yield* gateListing(context, kind, query)
      if (refused !== null) return { text: refused, isError: true }
      const refs = yield* entries(context, kind)
      const words = (query ?? "").toLocaleLowerCase().split(/\s+/).filter(Boolean)
      const matches = refs
        .map(identity)
        .filter((ref) =>
          words.every((word) => `${ref.name} ${ref.subtitle} ${ref.tags.join(" ")}`.toLocaleLowerCase().includes(word))
        )
      const cap = limit ?? 20
      return {
        frame: toolResultFrame({ entries: matches.slice(0, cap), remaining: Math.max(0, matches.length - cap) }),
        text: JSON.stringify({ entries: matches.slice(0, cap), remaining: Math.max(0, matches.length - cap) })
      }
    }).pipe(Effect.catch(failRead))
}

/** What a listing's question names (§2.4): "your characters and personas". */
const listedNoun: Record<EntityKind, string> = {
  card: "your characters and personas",
  lorebook: "your lorebooks",
  preset: "your presets",
  note: "your notes",
  preset_overlay: "your preset overlays"
}

/**
 * Listing names is covered by the class that reads them (spec/WORKSHOP-CARDS.md §2.2): a card's
 * name and tags often say what it is. Null: it may list; otherwise why not, for the model.
 */
export const gateListing = (context: ToolContext, kind: EntityKind, query: string | undefined) =>
  Effect.gen(function* () {
    if (!context.sight) return null
    const words = query?.trim()
    const allowed = yield* context.sight.gate(
      classOfKind(kind),
      words
        ? `It wants to search ${listedNoun[kind]} for “${words}”, and to read what it finds.`
        : `It wants to list ${listedNoun[kind]}, and to read what it finds.`
    )
    return allowed.ok ? null : allowed.text
  })

export const VIEWS = ["whole", "summary", "field", "index", "entry", "prompt"] as const

export const viewHelp: Record<"card" | "preset" | "lorebook", string> = {
  card: 'Views: "whole" (the default when it fits), "summary" (each field\'s size, the default when it\'s too long), "field" (one page of one field: field, and greeting for an alternate greeting, from 1), "index" (its lorebook\'s entries, 50 a page, after a uid), "entry" (one entry of its lorebook by uid, paged).',
  lorebook:
    'Views: "whole" (the default when it fits), "summary" (its entries\' sizes, the default when it\'s too long), "index" (its entries, 50 a page, after a uid), "entry" (one entry by uid, its content paged).',
  preset:
    'Views: "whole" (the default when it fits), "summary" (its prompts\' sizes, the default when it\'s too long), "index" (its prompts in order, 50 a page, after an identifier), "prompt" (one prompt by identifier, its content paged).'
}

/** A pinned read pages one selected value or the full JSON, by exact character offset. */
const readAttached = (
  context: ToolContext,
  kind: "card" | "preset" | "lorebook",
  args: Readonly<Record<string, unknown>>
) =>
  Effect.gen(function* () {
    const id = String(args[kind]) as RefId
    const revision = String(args.revision) as RevisionId
    if (!context.leafSlotId) return { text: "This turn has no attached library revision.", isError: true }
    const { name, doc } = yield* context.reader.GetAttachedLibraryRevision({
      userId: context.userId,
      chatId: context.chatId,
      forkId: context.forkId,
      leafSlotId: context.leafSlotId,
      kind,
      refId: id,
      revisionId: revision
    })
    const visible = kind === "card" ? withoutCardSkills(doc) : doc
    const record = (value: unknown) => value as Readonly<Record<string, unknown>>
    const selected =
      kind === "lorebook" && args.entry !== undefined
        ? (Array.isArray(visible.entries) ? visible.entries : []).find((entry) => record(entry).uid === args.entry)
        : kind === "preset" && args.prompt !== undefined
          ? (Array.isArray(visible.prompts) ? visible.prompts : []).find(
              (prompt) => record(prompt).identifier === args.prompt
            )
          : visible
    const value =
      typeof args.field === "string" && selected !== undefined
        ? Object.hasOwn(record(selected), args.field)
          ? record(selected)[args.field]
          : undefined
        : selected
    if (value === undefined)
      return { text: "That field, entry or prompt is absent from the attached revision.", isError: true }
    const identity = { id, name, revision }
    const data = typeof value === "string" ? value : JSON.stringify(value)
    const offset = Math.min(typeof args.offset === "number" ? args.offset : 0, data.length)
    const end = Math.min(offset + 4_000, data.length)
    return {
      frame: toolResultFrame(identity),
      text:
        offset === 0 && end === data.length
          ? JSON.stringify({ ...identity, doc: value })
          : JSON.stringify({
              ...identity,
              excerpt: data.slice(offset, end),
              offset,
              nextOffset: end < data.length ? end : null
            })
    }
  })

/**
 * The paged views read_card, read_lorebook, read_preset and read_card_file share (§4.3 point 2,
 * spec/WORKSHOP-CARDS.md §4.5): the answer, or null when the item is to be read whole.
 */
export const pagedView = (
  kind: "card" | "preset" | "lorebook",
  visible: Readonly<Record<string, unknown>>,
  doc: Readonly<Record<string, unknown>>,
  head: string,
  args: Readonly<Record<string, unknown>>,
  count: CountEffect,
  window: number | undefined
) =>
  Effect.gen(function* () {
    const answer = (text: string, isError = false): { readonly text: string; readonly isError?: boolean } => ({
      text,
      ...(isError ? { isError } : {})
    })
    const view = args.view as (typeof VIEWS)[number] | undefined
    const maxTokens = pageTokens(args.max_tokens)
    const summary = () =>
      Effect.map(
        withCounts(count, (c) => summaryLines(kind, visible, c)),
        (lines) => [head, ...lines].join("\n")
      )
    if (view === undefined || view === "whole") {
      const fits = (yield* count(JSON.stringify(doc))) <= inlineLimit(window)
      if (!fits)
        return answer(
          `${yield* summary()}\n${view === "whole" ? "Too long to read whole: read it by field." : "Too long to read whole: this is its summary. Read it with view field, index or entry."}`
        )
      return null
    }
    if (view === "summary") return answer(yield* summary())
    if (view === "index") {
      if (kind === "card" && visible.character_book === undefined) return answer("This card has no lorebook.", true)
      const after = args.after === undefined ? undefined : String(args.after)
      const lines = yield* withCounts(count, (c) => indexLines(kind, visible, after, c))
      return lines === null
        ? answer(`No ${kind === "preset" ? "prompt" : "entry"} ${after} to read after.`, true)
        : answer([head, ...lines].join("\n"))
    }
    if (view === "field") {
      if (kind !== "card")
        return answer(
          `A ${kind} is read by ${kind === "preset" ? "prompt" : "entry"}: use view index, then view ${kind === "preset" ? "prompt" : "entry"}.`,
          true
        )
      const field = String(args.field ?? "")
      if (field === "alternate_greetings") {
        const greetings = Array.isArray(visible.alternate_greetings) ? visible.alternate_greetings : []
        const n = typeof args.greeting === "number" ? args.greeting : 0
        const greeting = greetings[n - 1]
        if (typeof greeting !== "string") return answer(`Give greeting, from 1 to ${greetings.length}.`, true)
        return answer(
          `${head}, alternate greeting ${n}:\n${yield* pageOf(greeting, `alternate greeting ${n}`, args.offset, maxTokens, count)}`
        )
      }
      const value = visible[field]
      if (!CARD_TEXT_FIELDS.includes(field as (typeof CARD_TEXT_FIELDS)[number]) || typeof value !== "string")
        return answer(`Give field, one of ${[...CARD_TEXT_FIELDS, "alternate_greetings"].join(", ")}.`, true)
      return answer(`${head}, ${field}:\n${yield* pageOf(value, field, args.offset, maxTokens, count)}`)
    }
    // entry or prompt: its settings, then a page of its text.
    const wanted = view === "prompt" ? args.prompt : args.entry
    if ((view === "prompt") !== (kind === "preset") || wanted === undefined)
      return answer(
        kind === "preset" ? "Give prompt, an identifier from view index." : "Give entry, a uid from view index.",
        true
      )
    const part = findPart(kind, visible, String(wanted))
    if (part === null) return answer(`No ${view} ${String(wanted)}: see view index.`, true)
    const { content, ...settings } = part
    const what = view === "prompt" ? `prompt ${String(wanted)}` : `entry ${String(wanted)}`
    return answer(
      `${head}, ${what}: ${JSON.stringify(settings)}\ncontent:\n${yield* pageOf(typeof content === "string" ? content : "", `the content of ${what}`, args.offset, maxTokens, count)}`
    )
  })

/**
 * A cut page, or a summary in place of the whole, says the item can be saved to a file, where the
 * run offers export_to_file (§4.3 point 2): in the result, so the read tools' definitions stay
 * the same bytes whether files are offered or not.
 */
export const withExportHint = <T extends { readonly text: string; readonly isError?: boolean }>(
  context: ToolContext,
  viewed: T
): T =>
  viewed.isError !== true &&
  /Read on with offset=|Too long to read whole/.test(viewed.text) &&
  context.offer?.tools.some((tool) => tool.name === "export_to_file") === true
    ? { ...viewed, text: `${viewed.text}\nTo search or work on all of it, save it to a file with export_to_file.` }
    : viewed

const readTool = (kind: "card" | "preset" | "lorebook"): RolloutTool<Readonly<Record<string, unknown>>> => ({
  source: import.meta.url,
  id: `read_${kind}`,
  storyRead: "library",
  label: `Read a ${kind}`,
  explanation: `Read a ${kind} from your library.`,
  effect: "read",
  gatedBy: libraryClassIds,
  description: `Reads a ${kind} by name, library id or entity id: the saved library head, or, with revision, the revision a workshop message attached (by its library id). Whole when that fits, otherwise in pages. Page sizes are in tokens (max_tokens, 2,000 by default, 200 to 8,000); a cut page says the offset to read on from. ${viewHelp[kind]} Without a view, an attached revision reads one field, entry or prompt by character offset (nextOffset). Unsaved drafts are not included.`,
  parameters: Type.Object({
    [kind]: Type.String({ description: `The ${kind}'s name or id. Use the library id with revision.` }),
    revision: Type.Optional(Type.String({ description: "The revision id shown in an attachment." })),
    ...(kind === "card" ? { fields: Type.Optional(Type.Array(Type.String())) } : {}),
    view: Type.Optional(Type.Union(VIEWS.map((view) => Type.Literal(view)))),
    field: Type.Optional(
      Type.String({
        description:
          kind === "card"
            ? "For view field: the field, such as description. Without a view, for an attached revision: the field of the document to read."
            : "For an attached revision without a view: the field of the document, entry or prompt to read."
      })
    ),
    ...(kind === "card"
      ? {
          greeting: Type.Optional(
            Type.Integer({ minimum: 1, description: "For field alternate_greetings: which, from 1." })
          )
        }
      : {}),
    ...(kind === "preset"
      ? { prompt: Type.Optional(Type.String({ description: "For view prompt: its identifier." })) }
      : {
          entry: Type.Optional(Type.Union([Type.Integer(), Type.String()], { description: "For view entry: its uid." }))
        }),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "Where a page starts, in characters." })),
    max_tokens: Type.Optional(Type.Integer({ minimum: 200, maximum: 8000 })),
    after: Type.Optional(
      Type.Union([Type.Integer(), Type.String()], { description: "For view index: the last uid or identifier read." })
    )
  }),
  summarize: (args) =>
    args.view && args.view !== "whole" ? `${String(args[kind])} (${String(args.view)})` : String(args[kind]),
  execute: (context, args) =>
    Effect.gen(function* () {
      // An attached revision (spec/WORKSHOP-CARDS.md §4.3): without a view, one value by offset;
      // with one, the same paged views as the head's.
      if (args.revision !== undefined && args.view === undefined) return yield* readAttached(context, kind, args)
      let source: {
        readonly doc: Readonly<Record<string, unknown>>
        readonly ref: LibraryRef | null
        readonly id: string
        readonly label: string
        readonly revision: string
      }
      if (args.revision !== undefined) {
        if (!context.leafSlotId) return { text: "This turn has no attached library revision.", isError: true }
        const held = yield* context.reader.GetAttachedLibraryRevision({
          userId: context.userId,
          chatId: context.chatId,
          forkId: context.forkId,
          leafSlotId: context.leafSlotId,
          kind,
          refId: String(args[kind]) as RefId,
          revisionId: String(args.revision) as RevisionId
        })
        source = { doc: held.doc, ref: null, id: String(args[kind]), label: held.name, revision: String(args.revision) }
      } else {
        const found = yield* resolveLibrary(context, kind, String(args[kind]))
        if ("error" in found) return { text: found.error, isError: true }
        const snapshot = yield* context.reader.OpenEditor({ userId: context.userId, refId: found.ref.id })
        source = {
          doc: snapshot.doc,
          ref: snapshot.ref,
          id: snapshot.ref.id,
          label: snapshot.ref.label,
          revision: snapshot.ref.headRevisionId
        }
      }
      const visible = visibleDoc(kind, source.doc)
      const count: CountEffect = context.countTokens
        ? (text) => context.countTokens!(text).pipe(Effect.orElseSucceed(() => Math.ceil(text.length / 4)))
        : estimateCount
      const frame = toolResultFrame({
        id: source.id,
        ...(source.ref ? { entityId: source.ref.entityId } : {}),
        revision: source.revision
      })
      const head = `${kind} "${source.label}" (id ${source.id}, revision ${source.revision})`
      const answer = (text: string, isError = false) => ({ frame, text, ...(isError ? { isError } : {}) })
      const fields = args.fields as ReadonlyArray<string> | undefined
      const doc =
        kind === "card" && fields
          ? Object.fromEntries(
              Object.entries(visible).filter(
                ([key]) =>
                  fields.includes(key) ||
                  ["alternate_greetings", "character_book", "agent_editable_fields"].includes(key)
              )
            )
          : visible
      const viewed = yield* pagedView(kind, visible, doc, head, args, count, context.window)
      if (viewed !== null) return { frame, ...withExportHint(context, viewed) }
      const notes =
        kind === "card" && source.ref
          ? yield* context.reader.ListCardNotes({ userId: context.userId, cardRefId: source.ref.id })
          : undefined
      return answer(
        JSON.stringify({
          ...(source.ref ? identity(source.ref) : { id: source.id, name: source.label }),
          revision: source.revision,
          doc,
          ...(notes
            ? { notes: notes.map((note) => ({ id: note.ref.id, revision: note.ref.headRevisionId, doc: note.doc })) }
            : {})
        })
      )
    }).pipe(Effect.catch(failRead))
})

const readNote: RolloutTool<{ readonly note: string }> = {
  source: import.meta.url,
  id: "read_note",
  storyRead: "library",
  label: "Read a note",
  explanation: "Read a shared note or a card's note from your library.",
  effect: "read",
  gatedBy: libraryClassIds,
  description:
    "Reads a shared note or a card's note, by id or name: its saved revision and document. A chat's own notes are read with list_chat_notes.",
  parameters: Type.Object({ note: Type.String({ description: "The note's name or id." }) }),
  summarize: ({ note }) => note,
  execute: (context, { note }) =>
    Effect.gen(function* () {
      const found = yield* resolveLibrary(context, "note", String(note))
      if ("error" in found) return { text: found.error, isError: true }
      const snapshot = yield* context.reader.OpenEditor({ userId: context.userId, refId: found.ref.id })
      // A chat's note is story text at a branch's position: only the positioned read shows it.
      if ((snapshot.doc.owner as { chat?: unknown } | undefined)?.chat !== undefined)
        return { text: "That note belongs to one chat. Read it with list_chat_notes.", isError: true }
      return {
        frame: toolResultFrame({
          id: snapshot.ref.id,
          entityId: snapshot.ref.entityId,
          revision: snapshot.ref.headRevisionId
        }),
        text: JSON.stringify({ ...identity(snapshot.ref), revision: snapshot.ref.headRevisionId, doc: snapshot.doc })
      }
    }).pipe(Effect.catch(failRead))
}

export const libraryTools: ReadonlyArray<RolloutTool<never>> = [
  listLibrary,
  readTool("card"),
  readTool("preset"),
  readTool("lorebook"),
  readNote
].map((tool) => ({ ...tool, replyTool: false as const }))
