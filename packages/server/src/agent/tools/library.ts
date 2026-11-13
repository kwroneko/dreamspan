/** Library heads only; every lookup and snapshot is scoped to the rollout's owner. */
import { withoutCardSkills } from "../toolLoading.ts"
import { Type } from "@earendil-works/pi-ai"
import type { EntityKind, LibraryRef } from "@rp/shared/library.ts"
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
          text: JSON.stringify({ entries: matches.slice(0, cap), remaining: Math.max(0, matches.length - cap) })
        }
      }),
      Effect.catch(failRead)
    )
}

const readTool = (kind: "card" | "preset" | "lorebook"): RolloutTool<Readonly<Record<string, unknown>>> => ({
  id: `read_${kind}`,
  storyRead: "library",
  label: `Read a ${kind}`,
  explanation: `Read a ${kind} from your library.`,
  effect: "read",
  capability: "library.read",
  description: `Reads the saved library head of a ${kind}, by name, library id or entity id. Returns its revision and document. Unsaved drafts are not included.`,
  parameters: Type.Object({
    [kind]: Type.String({ description: `The ${kind}'s name or id.` }),
    ...(kind === "card" ? { fields: Type.Optional(Type.Array(Type.String())) } : {})
  }),
  summarize: (args) => String(args[kind]),
  execute: (context, args) =>
    Effect.gen(function* () {
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
      return { text: JSON.stringify({ ...identity(snapshot.ref), revision: snapshot.ref.headRevisionId, doc }) }
    }).pipe(Effect.catch(failRead))
})

export const libraryTools: ReadonlyArray<RolloutTool<never>> = [
  listLibrary,
  readTool("card"),
  readTool("preset"),
  readTool("lorebook")
]
