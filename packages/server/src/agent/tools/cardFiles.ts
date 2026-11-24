// The card file tools (spec/WORKSHOP-CARDS.md §4.5): a character card attached as a file stays a
// file. `read_card_file` reads it with read_card's views; `edit_card_file` makes edit_card's
// changes in the file's own format (the format worker keeps every other field, chunk and entry)
// and writes it back through the file tools as a new version, whose change names the fields it
// changed, before and after; `import_card_file` adds it to the library, as the library page's
// import does. Made inside `makeFileTools`, which hands over its file access.
import { Type } from "@earendil-works/pi-ai"
import { posix } from "node:path"
import { Effect } from "effect"
import type { RolloutEffectRecord } from "@dreamspan/shared/workshopApi.ts"
import { ATTACHMENT_COPY_ROOT } from "@dreamspan/shared/files.ts"
import type { Writer } from "../../db/Database.ts"
import type { CardFileInfo } from "../../importer/ops.ts"
import type { Formats } from "../../importer/Formats.ts"
import { storeMedia } from "../../importer/mediaFiles.ts"
import { prepareAvatarThumbnails } from "../../importer/prepareThumbnails.ts"
import { FilePathRefused, readRegularFile } from "../../files/safePath.ts"
import { type CountEffect, estimateCount, visibleDoc } from "../libraryView.ts"
import { ToolInputRefused, type RolloutTool, type ToolContext, type ToolOutput } from "../tools.ts"
import { pagedView, VIEWS } from "./library.ts"

/** The largest card file the tools read: CHARX files carry their assets. */
const CARD_FILE_BYTES = 32 * 2 ** 20

type Place = {
  readonly full: string
  readonly hostRoot: string
  readonly segments: ReadonlyArray<string>
  /** Set for an attachment copy as sent (read-only), null for a file in Files. */
  readonly mime: string | null
}

/** The account's file access the file tools resolved for the call; opaque here. */
type Env = never

export interface CardFileToolDeps {
  readonly formats: () => Formats["Service"] | undefined
  readonly dataDir: string
  readonly writer: () => Writer["Service"]
  readonly holding: <A, E, R>(hashes: ReadonlyArray<string>, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly wrap: (
    capability: string,
    run: (ctx: ToolContext, args: Record<string, unknown>, env: Env) => Effect.Effect<ToolOutput, unknown>
  ) => (ctx: ToolContext, args: Record<string, unknown>) => Effect.Effect<ToolOutput>
  /** Where a path to read is: a file in Files, or an attachment copy. */
  readonly readPlace: (ctx: ToolContext, env: Env, path: string) => Effect.Effect<Place, unknown>
  /** The file's bytes read here are what a later change must find (the file tools' check). */
  readonly markRead: (ctx: ToolContext, full: string, bytes: Uint8Array) => void
  readonly wasRead: (ctx: ToolContext, full: string) => boolean
  /** Writes the file as the file tools' edit does: a version of what was there, an undoable change. */
  readonly replace: (
    ctx: ToolContext,
    env: Env,
    path: string,
    next: (before: Buffer | null) => Buffer
  ) => Effect.Effect<{ readonly full: string; readonly effects: ReadonlyArray<RolloutEffectRecord> }, unknown>
}

const formatName = { png: "PNG", json: "JSON", charx: "CHARX" } as const

/** "card file /files/x/wren.png "Wren Hollow" (PNG, chara_card_v3 3.0)". */
const headOf = (full: string, info: CardFileInfo) =>
  `card file ${full} "${info.name}" (${formatName[info.format]}, ${info.spec} ${info.specVersion})`

/** The top-level fields an edit changed, as they were and as they are. */
export const changedCardFields = (
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>
) => {
  const was: Record<string, unknown> = {}
  const now: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      if (before[key] !== undefined) was[key] = before[key]
      if (after[key] !== undefined) now[key] = after[key]
    }
  return { before: was, after: now }
}

const name = Type.String({ maxLength: 4096 })
const text = Type.String({ maxLength: 2 ** 20 })
const strict = { additionalProperties: false } as const

export const makeCardFileTools = (deps: CardFileToolDeps) => {
  const formats = () => {
    const service = deps.formats()
    if (!service) throw new FilePathRefused("Card files can't be read on this server.")
    return service
  }
  const countOf = (ctx: ToolContext): CountEffect =>
    ctx.countTokens
      ? (t) => ctx.countTokens!(t).pipe(Effect.orElseSucceed(() => Math.ceil(t.length / 4)))
      : estimateCount

  /** The file's bytes and what it is as a card; a file that isn't one is refused. */
  const readCard = (ctx: ToolContext, env: Env, path: string) =>
    Effect.gen(function* () {
      const place = yield* deps.readPlace(ctx, env, path)
      const read = yield* Effect.tryPromise(() => readRegularFile(place.hostRoot, place.segments, CARD_FILE_BYTES + 1))
      if (read.truncated) return yield* Effect.fail(new FilePathRefused(`${place.full} is too large for a card file.`))
      const info = yield* formats().readCardFile(read.bytes)
      if (info === null)
        return yield* Effect.fail(
          new FilePathRefused(`${place.full} isn't a character card (a PNG with card data, card JSON or CHARX).`)
        )
      return { place, bytes: read.bytes, info }
    })

  const readTool: RolloutTool<Record<string, unknown>> = {
    source: import.meta.url,
    id: "read_card_file",
    label: "Read a card file",
    capability: "files",
    effect: "read",
    replyTool: false,
    storyRead: "account",
    titleField: "path",
    description: `Reads a character card file (a PNG with card data, card JSON or CHARX) in your files or a message attachment, by path, with the same views as read_card: whole when it fits, otherwise in pages; page sizes in tokens (max_tokens, 2,000 by default, 200 to 8,000). Views: "whole", "summary" (each field's size), "field" (one page of one field: field, and greeting for an alternate greeting, from 1), "index" (its lorebook's entries, 50 a page, after a uid), "entry" (one entry of its lorebook by uid, paged). Read a file in your files with this before you change it with edit_card_file.`,
    parameters: Type.Object(
      {
        path: name,
        view: Type.Optional(Type.Union(VIEWS.filter((view) => view !== "prompt").map((view) => Type.Literal(view)))),
        field: Type.Optional(Type.String({ description: "For view field: the field, such as description." })),
        greeting: Type.Optional(
          Type.Integer({ minimum: 1, description: "For field alternate_greetings: which, from 1." })
        ),
        entry: Type.Optional(Type.Union([Type.Integer(), Type.String()], { description: "For view entry: its uid." })),
        offset: Type.Optional(Type.Integer({ minimum: 0, description: "Where a page starts, in characters." })),
        max_tokens: Type.Optional(Type.Integer({ minimum: 200, maximum: 8000 })),
        after: Type.Optional(
          Type.Union([Type.Integer(), Type.String()], { description: "For view index: the last uid read." })
        )
      },
      strict
    ),
    summarize: (args) =>
      args.view && args.view !== "whole" ? `${String(args.path)} (${String(args.view)})` : String(args.path ?? ""),
    execute: deps.wrap("files", (ctx, args, env) =>
      Effect.gen(function* () {
        const { place, bytes, info } = yield* readCard(ctx, env, String(args.path))
        if (place.mime === null) deps.markRead(ctx, place.full, bytes)
        const visible = visibleDoc("card", info.doc)
        const head = headOf(place.full, info)
        const viewed = yield* pagedView("card", visible, visible, head, args, countOf(ctx), ctx.window)
        if (viewed !== null) return viewed
        return {
          text: JSON.stringify({
            path: place.full,
            name: info.name,
            format: info.format,
            spec: info.spec,
            spec_version: info.specVersion,
            doc: visible
          })
        }
      })
    )
  }

  const editTool: RolloutTool<Record<string, unknown>> = {
    source: import.meta.url,
    id: "edit_card_file",
    label: "Edited a card file",
    capability: "files",
    effect: "files",
    replyTool: false,
    storyRead: "account",
    titleField: "path",
    description:
      "Changes a character card file in your files that you read with read_card_file, in its own format (PNG, JSON or CHARX): every field, extension and picture it doesn't change stays as it is. Each change replaces a whole text field with text, or one exact find with replace, or sets alternate_greetings to a whole list with items. A find must occur exactly once. All changes save together, as a new version of the file the user can undo. A message attachment (/attachments) can't be changed: change its file in your files.",
    parameters: Type.Object(
      {
        path: name,
        changes: Type.Array(
          Type.Union([
            Type.Object({ field: name, text }, strict),
            Type.Object(
              { field: name, find: Type.String({ minLength: 1, maxLength: 2 ** 20 }), replace: text },
              strict
            ),
            Type.Object(
              { field: Type.Literal("alternate_greetings"), items: Type.Array(text, { maxItems: 512 }) },
              strict
            )
          ]),
          { minItems: 1, maxItems: 64 }
        )
      },
      strict
    ),
    summarize: (args) => String(args.path ?? ""),
    execute: deps.wrap("files", (ctx, args, env) =>
      Effect.gen(function* () {
        const path = String(args.path).trim()
        if (path.startsWith(`${ATTACHMENT_COPY_ROOT}/`))
          throw new FilePathRefused(
            "A message attachment is the copy as sent and can't be changed: change its file in your files (its file_path)."
          )
        const { place, bytes } = yield* readCard(ctx, env, path)
        if (!deps.wasRead(ctx, place.full))
          throw new FilePathRefused(`Read ${place.full} with read_card_file before changing it.`)
        const changes = args.changes as ReadonlyArray<{
          field: string
          text?: string
          find?: string
          replace?: string
          items?: ReadonlyArray<string>
        }>
        const edited = yield* formats().editCardFile(bytes, changes)
        if ("error" in edited) return { text: edited.error, isError: true }
        const read = Buffer.from(bytes)
        const done = yield* deps.replace(ctx, env, place.full, (before) => {
          // The file tools refuse a file changed since it was read; this is the bytes edited here.
          if (!before || !before.equals(read))
            throw new FilePathRefused(`${place.full} changed since you read it. Read it again before changing it.`)
          return Buffer.from(edited.bytes)
        })
        const fields = changedCardFields(visibleDoc("card", edited.before.doc), visibleDoc("card", edited.after.doc))
        const changed = Object.keys({ ...fields.before, ...fields.after })
        const effects = done.effects.map((effect) => ({
          ...effect,
          title: `Edited the card file ${done.full}`,
          undo: {
            ...effect.undo,
            card: { name: edited.after.name, format: edited.after.format, ...fields }
          }
        }))
        return {
          text: `Edited ${done.full} (${formatName[edited.after.format]} card "${edited.after.name}"): ${changed.length ? changed.join(", ") : "nothing changed"}.`,
          effects
        }
      })
    )
  }

  const importTool: RolloutTool<Record<string, unknown>> = {
    source: import.meta.url,
    id: "import_card_file",
    label: "Imported a card file",
    capability: "library.write",
    effect: "library",
    replyTool: false,
    storyRead: "account",
    titleField: "path",
    description:
      "Adds a character card file (in your files or a message attachment) to the library as a new card, with its picture, as the library's import does. Only when the user asks for it: a card file is otherwise worked on as a file.",
    parameters: Type.Object({ path: name }, strict),
    summarize: (args) => String(args.path ?? ""),
    execute: deps.wrap("library.write", (ctx, args, env) =>
      Effect.gen(function* () {
        const { place, bytes } = yield* readCard(ctx, env, String(args.path))
        const fileName = posix.basename(place.full)
        const parsed = yield* formats()
          .parse(bytes, fileName)
          .pipe(Effect.mapError(() => new FilePathRefused("The card file could not be read. Check that it is whole.")))
        if (parsed.library === null) return { text: `${place.full} could not be imported as a card.`, isError: true }
        // Where the card says it came from stays unread: no card source is linked here.
        const { links: _links, ...library } = parsed.library
        const saved = yield* deps.holding(
          parsed.media.map((file) => file.sha256),
          Effect.gen(function* () {
            yield* Effect.forEach(parsed.media, (file) => storeMedia(deps.dataDir, file.sha256, file.bytes), {
              discard: true
            })
            return yield* deps.writer().RunWorkshopOperation({
              userId: ctx.userId as never,
              rolloutId: ctx.rolloutId,
              toolCallId: ctx.toolCallId,
              capability: "library.write",
              ...(ctx.approvalDigest ? { approvalDigest: ctx.approvalDigest } : {}),
              expected: {},
              operation: "ImportFile",
              payload: {
                userId: ctx.userId,
                intoRefId: null,
                ...library,
                sourceName: fileName,
                sourceHash: parsed.sha256,
                media: parsed.media.map(({ bytes: _, ...file }) => file)
              }
            })
          })
        )
        yield* prepareAvatarThumbnails(formats(), deps.dataDir, parsed.media)
        const ref = (saved as { ref?: { id: string; label: string; kind: string } }).ref
        if (!ref) throw new ToolInputRefused("The card file could not be imported. Try again.")
        return {
          text: `Imported ${place.full} into the library as the ${ref.kind} "${ref.label}" (id ${ref.id}). The file stays as it is.`
        }
      })
    )
  }

  return [readTool, editTool, importTool] as const
}
