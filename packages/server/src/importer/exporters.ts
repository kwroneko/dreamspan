import { importStPreset } from "../formats/preset.ts"
// Library documents back out as files (ARCHITECTURE.md §11.4), in the format worker: a
// large lorebook takes as long to write as to read.
import { CardDoc } from "@rp/shared/docs/card.ts"
import { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import { NoteDoc } from "@rp/shared/docs/note.ts"
import { LegacyPresetDoc as PresetDoc } from "@rp/shared/docs/preset.ts"
import { Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import { exportCardCharx, exportCardJson, exportCardPng } from "../formats/cardExport.ts"
import { exportPromptPreset } from "../formats/presetSettings.ts"
import { exportLorebook } from "../formats/worldInfo.ts"
import { OUR_EXTENSION } from "../formats/lorebook.ts"
import type { ExportFormatInfo } from "@rp/shared/libraryImport.ts"
import { makeRegistry, type Registry } from "../registry.ts"
import { type ExportInput, ExportRefused } from "./ops.ts"
import { describeImage } from "./images.ts"
import { renderPicture } from "./thumbnail.ts"
import { avatarCropOf, snapCrop, WHOLE_PICTURE } from "@rp/shared/media.ts"

/** A 1×1 PNG for a card without an avatar, since a PNG card needs an image to live in. */
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
)

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp"
}

const decode =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, what: string) =>
  (json: string) =>
    Schema.decodeUnknownEffect(schema)(JSON.parse(json)).pipe(
      Effect.mapError(
        () => new ExportRefused({ message: `This ${what} isn't valid any more, so it can't be exported.` })
      )
    )

/**
 * The card with its notes (DESIGN §4.1a): ST's Character's Note from the card's first note,
 * if it's exportable and in-chat; every other exportable note in our extension namespace
 * (`extensions.rp_harness.notes`), which ST ignores and an import reads back. Private notes
 * never leave; a linked note goes as its shared note's text, which the caller put in it.
 * Conditions stay behind: they name cards by this library's ids.
 */
const withNotes = (card: CardDoc, noteDocJson: string | null, notesDocJson: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    let extensions = card.extensions
    const others: Array<NoteDoc> = []
    if (noteDocJson !== null) {
      const note = yield* decode(NoteDoc, "card's note")(noteDocJson)
      // ST's Character's Note is only ever in-chat: the tail is its depth 0. A note in a
      // section, or not placed (a persona's elsewhere, say), goes with the others.
      const { placement } = note
      // ST always sends its Character's Note and an import makes it on in every chat, so a note
      // that isn't (a new one, off until a chat switches it on) goes with the others.
      if (
        note.exportable &&
        note.on_by_default === true &&
        (!note.condition || note.condition.when === "always") &&
        !note.replaces &&
        note.move_group === undefined &&
        (placement.mode === "depth" || placement.mode === "tail")
      ) {
        const depth = placement.mode === "depth" ? placement.depth : 0
        extensions = { ...extensions, depth_prompt: { prompt: note.content, depth, role: placement.role } }
      } else others.push(note)
    }
    for (const json of notesDocJson) others.push(yield* decode(NoteDoc, "card's note")(json))
    const exportable = others.filter((note) => note.exportable)
    // A note without an id takes the first `note-N` (from its place in the list) no other note
    // already has, so an id kept from an earlier export is never taken twice.
    const taken = new Set(exportable.flatMap((note) => (note.module_id === undefined ? [] : [note.module_id])))
    const idOf = (note: NoteDoc, i: number) => {
      if (note.module_id !== undefined) return note.module_id
      let n = i + 1
      while (taken.has(`note-${n}`)) n++
      taken.add(`note-${n}`)
      return `note-${n}`
    }
    const notes = exportable
      // `agent_editable` stays behind: a file never grants the agent anything (DESIGN §11).
      .map((note, i) => ({
        id: idOf(note, i),
        title: note.title,
        content: note.content,
        placement: note.placement,
        ...(note.condition?.when === "own_turn" ? { condition: note.condition } : {}),
        ...(note.replaces?.kind === "card_field" && note.replaces.card === undefined
          ? { replaces: note.replaces, ...(note.own_position ? { own_position: true } : {}) }
          : {}),
        ...(note.move_group ? { move_group: note.move_group } : {}),
        ...(note.scan_lore ? { scan_lore: true } : {}),
        ...(note.on_by_default ? { on_by_default: true } : {})
      }))
    if (notes.length === 0) return { ...card, extensions }
    const ours = extensions[OUR_EXTENSION]
    return {
      ...card,
      extensions: { ...extensions, [OUR_EXTENSION]: { ...(Predicate.isObject(ours) ? ours : {}), notes } }
    }
  })

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 4))

/** An executable format and all metadata needed by routes and client choices. */
export interface Exporter extends ExportFormatInfo {
  readonly write: (input: ExportInput) => Effect.Effect<Uint8Array, ExportRefused>
}

export class Exporters extends Context.Service<Exporters, Registry<Exporter>>()("rp/importer/Exporters") {}

/**
 * The avatar's chosen cutout (ARCHITECTURE.md §14.5c) in our namespace
 * (`extensions.rp_harness.avatar_crop`), which ST ignores, with the image's size, so an import
 * applies it only to the image it was chosen on (ST's own crop makes another). Only in a file
 * that holds the image; the image itself goes whole.
 */
const withCrop = (card: CardDoc, avatar: ExportInput["avatar"]): CardDoc => {
  const crop = avatarCropOf(card.avatar_media_id, card.avatar_crop)
  if (crop === null || avatar === null) return card
  const image = describeImage(avatar.bytes)
  const ours = card.extensions[OUR_EXTENSION]
  const size =
    image.width !== null && image.height !== null ? { image_width: image.width, image_height: image.height } : {}
  return {
    ...card,
    extensions: {
      ...card.extensions,
      [OUR_EXTENSION]: { ...(Predicate.isObject(ours) ? ours : {}), avatar_crop: { ...crop, ...size } }
    }
  }
}

const cardWriter =
  (write: (card: CardDoc, input: ExportInput) => Effect.Effect<Uint8Array, ExportRefused>) => (input: ExportInput) =>
    Effect.gen(function* () {
      const card = yield* withNotes(
        yield* decode(CardDoc, "card")(input.docJson),
        input.noteDocJson,
        input.notesDocJson
      )
      const world = card.extensions.world
      const alias = typeof world === "string" ? world : null
      const renamed =
        alias !== null && input.worldNames && Object.hasOwn(input.worldNames, alias)
          ? { ...card, extensions: { ...card.extensions, world: input.worldNames[alias]! } }
          : card
      return yield* write(withCrop(renamed, input.avatar), input)
    })

const builtins: ReadonlyArray<Exporter> = [
  {
    id: "card-png",
    kind: "card",
    label: "PNG",
    mime: "image/png",
    extension: "png",
    media: "avatar",
    description: "A PNG of its avatar with the card inside, as most apps share cards. Embedded assets stay out.",
    write: cardWriter((originalCard, input) =>
      Effect.gen(function* () {
        let card = originalCard
        const crop = avatarCropOf(card.avatar_media_id, card.avatar_crop)
        const picture = crop?.picture ?? WHOLE_PICTURE
        const image = input.avatar
          ? yield* Effect.tryPromise({
              try: () => renderPicture(input.avatar!.bytes, picture),
              catch: () => new ExportRefused({ message: "The picture couldn't be rendered as PNG." })
            })
          : PLACEHOLDER_PNG
        if (crop) {
          const ours = card.extensions[OUR_EXTENSION]
          const size = describeImage(image)
          card = {
            ...card,
            extensions: {
              ...card.extensions,
              [OUR_EXTENSION]: {
                ...(Predicate.isObject(ours) ? ours : {}),
                avatar_crop: {
                  ...snapCrop({
                    x: Math.max(0, (crop.x - picture.x) / picture.width),
                    y: Math.max(0, (crop.y - picture.y) / picture.height),
                    width: crop.width / picture.width,
                    height: crop.height / picture.height
                  }),
                  image_width: size.width,
                  image_height: size.height
                }
              }
            }
          }
        }
        return yield* exportCardPng(card, image).pipe(
          Effect.mapError(() => new ExportRefused({ message: "The card's avatar isn't a valid PNG." }))
        )
      })
    )
  },
  {
    id: "card-v2-json",
    kind: "card",
    label: "V2 JSON",
    mime: "application/json",
    extension: "json",
    media: "none",
    description: "The card as Character Card V2 JSON, with no images: for apps that don’t read V3.",
    write: cardWriter((card) => Effect.succeed(exportCardJson(card, "v2")))
  },
  {
    id: "card-v3-json",
    kind: "card",
    label: "V3 JSON",
    mime: "application/json",
    extension: "json",
    media: "none",
    description: "The card as Character Card V3 JSON, with no images.",
    write: cardWriter((card) => Effect.succeed(exportCardJson(card, "v3")))
  },
  {
    id: "card-charx",
    kind: "card",
    label: "CHARX",
    mime: "application/zip",
    extension: "charx",
    media: "all",
    description: "A CHARX archive: the card with its avatar and every embedded asset.",
    write: cardWriter((card, input) =>
      Effect.sync(() => {
        const mainIcon = card.assets?.find(
          (asset) => asset.type.toLowerCase() === "icon" && asset.name.toLowerCase() === "main"
        )
        const avatar = input.avatar && {
          uri: mainIcon?.uri ?? "ccdefault:",
          ext: EXTENSIONS[input.avatar.mime] ?? "png",
          bytes: input.avatar.bytes
        }
        const assets = input.assets.map((asset) => ({ uri: asset.uri, ext: "", bytes: asset.bytes }))
        return exportCardCharx(card, { avatar, assets })
      })
    )
  },
  {
    id: "st-world-info",
    kind: "lorebook",
    label: "World Info JSON",
    mime: "application/json",
    extension: "json",
    media: "none",
    description: "The lorebook as a SillyTavern World Info file.",
    write: (input) => Effect.map(decode(LorebookDoc, "lorebook")(input.docJson), exportLorebook)
  },
  {
    id: "st-preset",
    kind: "preset",
    label: "Preset JSON",
    mime: "application/json",
    extension: "json",
    media: "none",
    description: "Its prompts as a SillyTavern chat-completion preset, with no model or connection settings.",
    // Hydrate legacy export fields from a recognized chat-completion document.
    // Prompt-only revisions deliberately have no sampler or wire fields.
    write: (input) =>
      Effect.map(
        decode(
          PresetDoc,
          "preset"
        )(JSON.stringify({ ...importStPreset('{"main_prompt":""}').document, ...JSON.parse(input.docJson) })),
        (doc) => json(exportPromptPreset(doc))
      )
  }
]

/** Each worker owns its registry; plugin registrations use this same scoped service. */
export const layer = Layer.effect(
  Exporters,
  Effect.gen(function* () {
    const registry = makeRegistry<Exporter>()
    for (const entry of builtins) yield* registry.register(entry)
    return registry
  })
)

/** Honor the current service; standalone callers without one get scoped built-ins. */
export const exportFile = (
  input: ExportInput,
  registry?: Registry<Exporter>
): Effect.Effect<Uint8Array, ExportRefused> =>
  registry === undefined
    ? Effect.gen(function* () {
        const current = yield* Effect.serviceOption(Exporters)
        if (Option.isSome(current)) return yield* exportFile(input, current.value)
        return yield* Effect.flatMap(Exporters, (registry) => exportFile(input, registry)).pipe(Effect.provide(layer))
      })
    : Effect.suspend(() => {
        const entry = registry.get(input.format)
        if (!entry) return Effect.fail(new ExportRefused({ message: `Unknown export format: ${input.format}` }))
        // The catalog lookup and this request may use different pool workers or
        // straddle a scope closing. Never write bytes with another entry's headers/media.
        const expected = input.expectedFormat
        if (
          expected &&
          (expected.id !== entry.id ||
            expected.kind !== entry.kind ||
            expected.mime !== entry.mime ||
            expected.extension !== entry.extension ||
            expected.media !== entry.media)
        )
          return Effect.fail(new ExportRefused({ message: "The export format changed; try exporting again." }))
        return entry.write(input)
      })

/** Never pass executable code across the worker boundary. */
export const listFormats = (registry: Registry<Exporter>): ReadonlyArray<ExportFormatInfo> =>
  registry.list().map(({ id, kind, label, mime, extension, media, description }) => ({
    id,
    kind,
    label,
    mime,
    extension,
    media,
    ...(description === undefined ? {} : { description })
  }))
