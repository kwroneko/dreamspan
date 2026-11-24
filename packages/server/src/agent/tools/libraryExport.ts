// export_to_file (spec/WORKSHOP-CARDS.md §4.3 point 2, unit C2c): a card's field, a lorebook
// entry, a preset prompt or a whole item written as text to the working folder, so search_files
// and bash can work on all of it. Nothing comes back from the file into the item except through
// the edit tools. Delta from reference-harness's `export_text` / `export_card_json` views of its card
// tool (`src/tools/character-card.ts`): a tool of its own among the file tools rather than a view,
// so it's offered exactly where write_file is and the read tools' definitions never change; it
// reads library items (a head, any revision, or an attached one) rather than workspace card files;
// and it writes through the file tools' own path (`makeFileTools`), so the Files capability,
// the working folder, quota, versions and Undo are theirs. Like reference-harness's, it never replaces a
// file: a taken name gets " (2)".
import { Type } from "@earendil-works/pi-ai"
import type { LibraryRef, RefId, RevisionId } from "@dreamspan/shared/library.ts"
import type { RolloutEffectRecord } from "@dreamspan/shared/workshopApi.ts"
import { Effect } from "effect"
import { libraryClassIds } from "../capabilities.ts"
import { CARD_TEXT_FIELDS, findPart, visibleDoc } from "../libraryView.ts"
import { toolResultFrame } from "../toolData.ts"
import { ToolInputRefused, type RolloutTool, type ToolContext, type ToolOutput } from "../tools.ts"
import { cardSightRefusal, mayReadCardBook, resolveLibrary } from "./library.ts"
import { findRevision } from "./versions.ts"

const EXPORT_TOOL = "export_to_file"

/** The largest text written, as write_file's content. */
const EXPORT_MAX_BYTES = 8 * 2 ** 20

type Kind = "card" | "preset" | "lorebook"
type Doc = Readonly<Record<string, unknown>>

/** The account's file access the file tools resolved for the call; opaque here. */
type Env = never

export interface LibraryExportDeps {
  readonly wrap: (
    capability: string,
    run: (ctx: ToolContext, args: Record<string, unknown>, env: Env) => Effect.Effect<ToolOutput, unknown>
  ) => (ctx: ToolContext, args: Record<string, unknown>) => Effect.Effect<ToolOutput>
  /**
   * Creates a new file as write_file does (the working folder, the writable roots, quota, an
   * undoable change), at `path` or, without one, `name` in the working directory; a taken name
   * gets " (2)", never replaced.
   */
  readonly create: (
    ctx: ToolContext,
    env: Env,
    path: string | undefined,
    name: string,
    content: Buffer
  ) => Effect.Effect<{ readonly full: string; readonly effects: ReadonlyArray<RolloutEffectRecord> }, unknown>
}

interface Source {
  readonly doc: Doc
  readonly ref: LibraryRef | null
  readonly id: string
  readonly label: string
  readonly revision: string
}

/**
 * The item as the read tools find it: an attached revision by its library id (the message's
 * frozen copy, read without asking), else by name or id through what the reply may see
 * (`resolveLibrary`, which asks outside view), at its head or a revision as list_revisions names it.
 */
const sourceOf = (ctx: ToolContext, kind: Kind, item: string, revision: string | undefined) =>
  Effect.gen(function* () {
    if (revision !== undefined && ctx.leafSlotId) {
      const held = yield* ctx.reader
        .GetAttachedLibraryRevision({
          userId: ctx.userId,
          chatId: ctx.chatId,
          forkId: ctx.forkId,
          leafSlotId: ctx.leafSlotId,
          kind,
          refId: item as RefId,
          revisionId: revision as RevisionId
        })
        .pipe(Effect.orElseSucceed(() => null))
      if (held) return { doc: held.doc, ref: null, id: item, label: held.name, revision } satisfies Source
    }
    const found = yield* resolveLibrary(ctx, kind, item)
    if ("error" in found) return { error: found.error }
    if (revision === undefined) {
      const snapshot = yield* ctx.reader.OpenEditor({ userId: ctx.userId, refId: found.ref.id })
      return {
        doc: snapshot.doc,
        ref: snapshot.ref,
        id: snapshot.ref.id,
        label: snapshot.ref.label,
        revision: snapshot.ref.headRevisionId
      } satisfies Source
    }
    const at = yield* findRevision(ctx, found.ref, revision)
    if ("error" in at) return { error: at.error }
    const doc = yield* ctx.reader.GetRevisionDoc({
      userId: ctx.userId,
      refId: found.ref.id,
      revisionId: at.revision.id
    })
    return { doc, ref: found.ref, id: found.ref.id, label: found.ref.label, revision: at.revision.id } satisfies Source
  })

/** What the call names, as text, and the words its default file name ends with. */
const targetOf = (
  kind: Kind,
  visible: Doc,
  args: Readonly<Record<string, unknown>>
): { readonly text: string; readonly what: string; readonly stem: string; readonly ext: string } => {
  const field = typeof args.field === "string" ? args.field : undefined
  if (field !== undefined) {
    if (kind !== "card")
      throw new ToolInputRefused(
        `A ${kind} is written by ${kind === "preset" ? "prompt" : "entry"}, or whole: give ${kind === "preset" ? "prompt" : "entry"}, or nothing.`
      )
    if (field === "alternate_greetings") {
      const greetings = Array.isArray(visible.alternate_greetings) ? visible.alternate_greetings : []
      const n = typeof args.greeting === "number" ? args.greeting : 0
      const greeting = greetings[n - 1]
      if (typeof greeting !== "string")
        throw new ToolInputRefused(
          greetings.length === 0
            ? "This card has no alternate greetings."
            : `Give greeting, from 1 to ${greetings.length}.`
        )
      return { text: greeting, what: `alternate greeting ${n}`, stem: `alternate greeting ${n}`, ext: ".txt" }
    }
    const value = visible[field]
    if (!CARD_TEXT_FIELDS.includes(field as (typeof CARD_TEXT_FIELDS)[number]) || typeof value !== "string")
      throw new ToolInputRefused(`Give field, one of ${[...CARD_TEXT_FIELDS, "alternate_greetings"].join(", ")}.`)
    return { text: value, what: field, stem: field, ext: ".txt" }
  }
  const wanted = kind === "preset" ? args.prompt : args.entry
  if (wanted !== undefined) {
    if (kind === "card" && visible.character_book === undefined)
      throw new ToolInputRefused("This card has no lorebook.")
    const part = findPart(kind, visible, String(wanted))
    if (part === null)
      throw new ToolInputRefused(
        `No ${kind === "preset" ? "prompt" : "entry"} ${String(wanted)}: see the read tool's view index.`
      )
    const what = `${kind === "preset" ? "prompt" : "entry"} ${String(wanted)}`
    return {
      text: typeof part.content === "string" ? part.content : "",
      what: `the content of ${what}`,
      stem: what,
      ext: ".txt"
    }
  }
  if (kind === "preset" ? args.entry !== undefined : args.prompt !== undefined)
    throw new ToolInputRefused(kind === "preset" ? "A preset has prompts: give prompt." : "Give entry, a uid.")
  return { text: `${JSON.stringify(visible, null, 2)}\n`, what: `the whole ${kind}`, stem: "", ext: ".json" }
}

/** A name for a file: no slashes or control characters, no leading dots, at most 120 characters. */
const fileNameOf = (label: string, stem: string, ext: string, kind: Kind) => {
  const base = [label, stem]
    .join(" ")
    .replace(/[\u0000-\u001f\u007f/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim()
  return `${base === "" ? kind : base}${ext}`
}

const number = (n: number) => n.toLocaleString("en-US")

export const makeLibraryExportTool = (deps: LibraryExportDeps): RolloutTool<Record<string, unknown>> => ({
  source: import.meta.url,
  id: EXPORT_TOOL,
  label: "Saved to a file",
  explanation: "Save a card's field, a lorebook entry, a preset prompt or a whole item to a file in your files.",
  capability: "files",
  gatedBy: libraryClassIds,
  effect: "files",
  replyTool: false,
  storyRead: "library",
  titleField: "item",
  description:
    "Writes a card's field, a lorebook entry, a preset prompt or a whole card, lorebook or preset as text to a new file in your files, so search_files and bash can work on all of it when it's too long to read in pages. Give field (and greeting) for a card's field, entry (a uid, also for a card's lorebook) or prompt (an identifier), or none of them for the whole item as JSON. revision reads an earlier revision (a number from list_revisions, an id, or the revision an attachment shows). path: where, absolute or relative to the working directory (default: a file named after the item there); an existing file is never replaced, a taken name gets (2). The file is a copy: changing it changes nothing in the library; change the item with its edit tools. The user can undo the new file.",
  parameters: Type.Object(
    {
      kind: Type.Union([Type.Literal("card"), Type.Literal("preset"), Type.Literal("lorebook")]),
      item: Type.String({ minLength: 1, maxLength: 200, description: "The item's name or id." }),
      revision: Type.Optional(
        Type.String({ minLength: 1, maxLength: 100, description: "An earlier revision: number, id or latest." })
      ),
      field: Type.Optional(Type.String({ description: "A card's text field, such as description." })),
      greeting: Type.Optional(
        Type.Integer({ minimum: 1, description: "For field alternate_greetings: which, from 1." })
      ),
      entry: Type.Optional(Type.Union([Type.Integer(), Type.String()], { description: "A lorebook entry's uid." })),
      prompt: Type.Optional(Type.String({ description: "A preset prompt's identifier." })),
      path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 }))
    },
    { additionalProperties: false }
  ),
  summarize: (args) => String(args.item ?? ""),
  execute: deps.wrap("files", (ctx, args, env) =>
    Effect.gen(function* () {
      const kind = args.kind as Kind
      const revision = typeof args.revision === "string" ? args.revision : undefined
      const source = yield* sourceOf(ctx, kind, String(args.item), revision).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Workshop library export read failed", error).pipe(
            Effect.as({
              error: "The library entry could not be read. Check its name, id and revision and try again."
            })
          )
        )
      )
      if ("error" in source) return { text: source.error, isError: true }
      const showBook = source.ref === null || (yield* mayReadCardBook(ctx, source.ref, source.doc))
      if (source.ref !== null) {
        const refusal = yield* cardSightRefusal(ctx, source.ref)
        if (refusal !== null) return { text: refusal, isError: true }
      }
      if (!showBook && args.entry !== undefined && args.field === undefined)
        throw new ToolInputRefused("The workshop doesn't have access to this card's lorebook.")
      const target = targetOf(kind, visibleDoc(kind, source.doc, showBook), args)
      const content = Buffer.from(target.text, "utf8")
      if (content.byteLength > EXPORT_MAX_BYTES)
        throw new ToolInputRefused(
          `${target.what} is over ${EXPORT_MAX_BYTES / 2 ** 20} MiB: write a field, entry or prompt.`
        )
      const name = fileNameOf(source.label, target.stem, target.ext, kind)
      const written = yield* deps.create(ctx, env, typeof args.path === "string" ? args.path : undefined, name, content)
      const lines = target.text === "" ? 0 : target.text.split("\n").length
      return {
        frame: toolResultFrame({
          id: source.id,
          ...(source.ref ? { entityId: source.ref.entityId } : {}),
          revision: source.revision,
          path: written.full
        }),
        text: `Wrote ${target.what} of ${kind} "${source.label}" (id ${source.id}, revision ${source.revision}) to ${written.full}: ${number(target.text.length)} characters, ${number(lines)} lines. It's a copy: changing it changes nothing in the library.`,
        effects: written.effects
      }
    })
  )
})
