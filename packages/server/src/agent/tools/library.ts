import { toolResultFrame } from "../toolData.ts"
/** Library heads only; every lookup and snapshot is scoped to the rollout's owner. */
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
import { Type } from "@earendil-works/pi-ai"
import type { EntityKind, LibraryRef } from "@dreamspan/shared/library.ts"
import { Effect } from "effect"
import type { RolloutTool, ToolContext } from "../tools.ts"

const failRead = (error: unknown) =>
  Effect.logWarning("Workshop library read failed", error).pipe(
    Effect.as({ text: "The library entry could not be read. Check its name or id and try again.", isError: true })
  )

const entries = (context: ToolContext, kind: EntityKind, archived = false) =>
  context.reader.ListLibrary({ userId: context.userId, kind, tag: null, archived, withFilterData: true })

export const resolveLibrary = (context: ToolContext, kind: EntityKind, name: string) =>
  Effect.gen(function* () {
    const refs = [...(yield* entries(context, kind)), ...(yield* entries(context, kind, true))]
    const id = refs.find((ref) => ref.id === name || ref.entityId === name)
    const matches = id ? [id] : refs.filter((ref) => ref.label.toLocaleLowerCase() === name.toLocaleLowerCase())
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
  capability: "library.read",
  description: "Lists your library entries with names, ids, subtitles and tags. Use an id when names are ambiguous.",
  parameters: Type.Object({
    kind: Type.Union([Type.Literal("card"), Type.Literal("preset"), Type.Literal("lorebook"), Type.Literal("note")]),
    query: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
  }),
  summarize: ({ query, kind }) => query ?? kind,
  execute: (context, { kind, query, limit }) =>
    entries(context, kind).pipe(
      Effect.map((refs) => {
        const words = (query ?? "").toLocaleLowerCase().split(/\s+/).filter(Boolean)
        const matches = refs
          .map(identity)
          .filter((ref) =>
            words.every((word) =>
              `${ref.name} ${ref.subtitle} ${ref.tags.join(" ")}`.toLocaleLowerCase().includes(word)
            )
          )
        const cap = limit ?? 20
        return {
          frame: toolResultFrame({ entries: matches.slice(0, cap), remaining: Math.max(0, matches.length - cap) }),
          text: JSON.stringify({ entries: matches.slice(0, cap), remaining: Math.max(0, matches.length - cap) })
        }
      }),
      Effect.catch(failRead)
    )
}

const VIEWS = ["whole", "summary", "field", "index", "entry", "prompt"] as const

const viewHelp: Record<"card" | "preset" | "lorebook", string> = {
  card: 'Views: "whole" (the default when it fits), "summary" (each field\'s size, the default when it\'s too long), "field" (one page of one field: field, and greeting for an alternate greeting, from 1), "index" (its lorebook\'s entries, 50 a page, after a uid), "entry" (one entry of its lorebook by uid, paged).',
  lorebook:
    'Views: "whole" (the default when it fits), "summary" (its entries\' sizes, the default when it\'s too long), "index" (its entries, 50 a page, after a uid), "entry" (one entry by uid, its content paged).',
  preset:
    'Views: "whole" (the default when it fits), "summary" (its prompts\' sizes, the default when it\'s too long), "index" (its prompts in order, 50 a page, after an identifier), "prompt" (one prompt by identifier, its content paged).'
}

const readTool = (kind: "card" | "preset" | "lorebook"): RolloutTool<Readonly<Record<string, unknown>>> => ({
  source: import.meta.url,
  id: `read_${kind}`,
  storyRead: "library",
  label: `Read a ${kind}`,
  explanation: `Read a ${kind} from your library.`,
  effect: "read",
  capability: "library.read",
  description: `Reads the saved library head of a ${kind}, by name, library id or entity id: its revision and document, whole when that fits, otherwise in pages. Page sizes are in tokens (max_tokens, 2,000 by default, 200 to 8,000); a cut page says the offset to read on from. ${viewHelp[kind]} Unsaved drafts are not included.`,
  parameters: Type.Object({
    [kind]: Type.String({ description: `The ${kind}'s name or id.` }),
    ...(kind === "card" ? { fields: Type.Optional(Type.Array(Type.String())) } : {}),
    view: Type.Optional(Type.Union(VIEWS.map((view) => Type.Literal(view)))),
    ...(kind === "card"
      ? {
          field: Type.Optional(Type.String({ description: "For view field: the field, such as description." })),
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
      const found = yield* resolveLibrary(context, kind, String(args[kind]))
      if ("error" in found) return { text: found.error, isError: true }
      const snapshot = yield* context.reader.OpenEditor({ userId: context.userId, refId: found.ref.id })
      const visible = visibleDoc(kind, snapshot.doc)
      const count: CountEffect = context.countTokens
        ? (text) => context.countTokens!(text).pipe(Effect.orElseSucceed(() => Math.ceil(text.length / 4)))
        : estimateCount
      const frame = toolResultFrame({
        id: snapshot.ref.id,
        entityId: snapshot.ref.entityId,
        revision: snapshot.ref.headRevisionId
      })
      const head = `${kind} "${snapshot.ref.label}" (id ${snapshot.ref.id}, revision ${snapshot.ref.headRevisionId})`
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
      const view = args.view as (typeof VIEWS)[number] | undefined
      const maxTokens = pageTokens(args.max_tokens)
      const summary = () =>
        Effect.map(
          withCounts(count, (c) => summaryLines(kind, visible, c)),
          (lines) => [head, ...lines].join("\n")
        )
      if (view === undefined || view === "whole") {
        const fits = (yield* count(JSON.stringify(doc))) <= inlineLimit(context.window)
        if (!fits)
          return answer(
            `${yield* summary()}\n${view === "whole" ? "Too long to read whole: read it by field." : "Too long to read whole: this is its summary. Read it with view field, index or entry."}`
          )
        const notes =
          kind === "card"
            ? yield* context.reader.ListCardNotes({ userId: context.userId, cardRefId: snapshot.ref.id })
            : undefined
        return answer(
          JSON.stringify({
            ...identity(snapshot.ref),
            revision: snapshot.ref.headRevisionId,
            doc,
            ...(notes
              ? { notes: notes.map((note) => ({ id: note.ref.id, revision: note.ref.headRevisionId, doc: note.doc })) }
              : {})
          })
        )
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
    }).pipe(Effect.catch(failRead))
})

const readNote: RolloutTool<{ readonly note: string }> = {
  source: import.meta.url,
  id: "read_note",
  storyRead: "library",
  label: "Read a note",
  explanation: "Read a shared note or a card's note from your library.",
  effect: "read",
  capability: "library.read",
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
