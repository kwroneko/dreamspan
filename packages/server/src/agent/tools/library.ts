import { toolResultFrame } from "../toolData.ts"
/** Library heads and attached revisions, scoped to the rollout's owner. */
import { withoutCardSkills } from "../toolLoading.ts"
import { Type } from "@earendil-works/pi-ai"
import type { EntityKind, LibraryRef, RefId, RevisionId } from "@dreamspan/shared/library.ts"
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

const readTool = (kind: "card" | "preset" | "lorebook"): RolloutTool<Readonly<Record<string, unknown>>> => ({
  source: import.meta.url,
  id: `read_${kind}`,
  storyRead: "library",
  label: `Read a ${kind}`,
  explanation: `Read a ${kind} from your library.`,
  effect: "read",
  capability: "library.read",
  description: `Reads the saved library head of a ${kind}, by name, library id or entity id. To read an attached revision, provide its library id and revision from the attachment. Attached reads support a field and continuation by offset.`,
  parameters: Type.Object({
    [kind]: Type.String({ description: `The ${kind}'s name or id. Use the library id with revision.` }),
    revision: Type.Optional(Type.String({ description: "The revision id shown in an attachment." })),
    field: Type.Optional(
      Type.String({ description: "For attached revisions, the field of the document, entry or prompt to read." })
    ),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "The nextOffset from an attached read." })),
    ...(kind === "card" ? { fields: Type.Optional(Type.Array(Type.String())) } : {}),
    ...(kind === "lorebook"
      ? { entry: Type.Optional(Type.Integer({ description: "The uid of an attached lorebook entry." })) }
      : {}),
    ...(kind === "preset"
      ? { prompt: Type.Optional(Type.String({ description: "The identifier of an attached preset prompt." })) }
      : {})
  }),
  summarize: (args) => String(args[kind]),
  execute: (context, args) =>
    Effect.gen(function* () {
      if (args.revision !== undefined) return yield* readAttached(context, kind, args)
      const found = yield* resolveLibrary(context, kind, String(args[kind]))
      if ("error" in found) return { text: found.error, isError: true }
      const snapshot = yield* context.reader.OpenEditor({ userId: context.userId, refId: found.ref.id })
      const visible = kind === "card" ? withoutCardSkills(snapshot.doc) : snapshot.doc
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
      const notes =
        kind === "card"
          ? yield* context.reader.ListCardNotes({ userId: context.userId, cardRefId: snapshot.ref.id })
          : undefined
      return {
        frame: toolResultFrame({
          id: snapshot.ref.id,
          entityId: snapshot.ref.entityId,
          revision: snapshot.ref.headRevisionId
        }),
        text: JSON.stringify({
          ...identity(snapshot.ref),
          revision: snapshot.ref.headRevisionId,
          doc,
          ...(notes
            ? { notes: notes.map((note) => ({ id: note.ref.id, revision: note.ref.headRevisionId, doc: note.doc })) }
            : {})
        })
      }
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
