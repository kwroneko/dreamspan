import { importStPreset } from "../formats/preset.ts"
// Library documents back out as files (ARCHITECTURE.md §11.4), in the format worker: a
// large lorebook takes as long to write as to read.
import { CardDoc } from "@rp/shared/docs/card.ts"
import { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import { NoteDoc } from "@rp/shared/docs/note.ts"
import { LegacyPresetDoc as PresetDoc } from "@rp/shared/docs/preset.ts"
import { Context, Effect, Layer, Predicate, Schema } from "effect"
import { exportCardCharx, exportCardJson, exportCardPng } from "../formats/cardExport.ts"
import { exportPromptPreset } from "../formats/presetSettings.ts"
import { exportLorebook } from "../formats/worldInfo.ts"
import { OUR_EXTENSION } from "../formats/lorebook.ts"
import type { ExportFormatInfo } from "@rp/shared/libraryImport.ts"
import { makeRegistry, type Registry } from "../registry.ts"
import { type ExportInput, ExportRefused } from "./ops.ts"

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
      if (note.exportable && note.on_by_default === true && (placement.mode === "depth" || placement.mode === "tail")) {
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

const cardWriter =
  (write: (card: CardDoc, input: ExportInput) => Effect.Effect<Uint8Array, ExportRefused>) => (input: ExportInput) =>
    Effect.gen(function* () {
      const card = yield* withNotes(
        yield* decode(CardDoc, "card")(input.docJson),
        input.noteDocJson,
        input.notesDocJson
      )
      return yield* write(card, input)
    })

const builtins: ReadonlyArray<Exporter> = [
  {
    id: "card-png",
    kind: "card",
    label: "PNG",
    mime: "image/png",
    extension: "png",
    media: "avatar",
    write: cardWriter((card, input) =>
      Effect.gen(function* () {
        if (input.avatar && input.avatar.mime !== "image/png") {
          const type = (EXTENSIONS[input.avatar.mime] ?? "non-PNG").toUpperCase()
          return yield* new ExportRefused({
            message: `This card's avatar is a ${type} image, which a PNG card can't hold. Export it as CHARX, which keeps the image, or as JSON.`
          })
        }
        return yield* exportCardPng(card, input.avatar?.bytes ?? PLACEHOLDER_PNG).pipe(
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
    write: cardWriter((card) => Effect.succeed(exportCardJson(card, "v2")))
  },
  {
    id: "card-v3-json",
    kind: "card",
    label: "V3 JSON",
    mime: "application/json",
    extension: "json",
    media: "none",
    write: cardWriter((card) => Effect.succeed(exportCardJson(card, "v3")))
  },
  {
    id: "card-charx",
    kind: "card",
    label: "CHARX",
    mime: "application/zip",
    extension: "charx",
    media: "all",
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
    write: (input) => Effect.map(decode(LorebookDoc, "lorebook")(input.docJson), exportLorebook)
  },
  {
    id: "st-preset",
    kind: "preset",
    label: "Preset JSON",
    mime: "application/json",
    extension: "json",
    media: "none",
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

/** Direct format callers get the built-ins; workers pass their scoped registry. */
export const exportFile = (
  input: ExportInput,
  registry?: Registry<Exporter>
): Effect.Effect<Uint8Array, ExportRefused> =>
  registry === undefined
    ? Effect.flatMap(Exporters, (registry) => exportFile(input, registry)).pipe(Effect.provide(layer))
    : Effect.suspend(() => {
        const entry = registry.get(input.format)
        return entry
          ? entry.write(input)
          : Effect.fail(new ExportRefused({ message: `Unknown export format: ${input.format}` }))
      })

/** Never pass executable code across the worker boundary. */
export const listFormats = (registry: Registry<Exporter>): ReadonlyArray<ExportFormatInfo> =>
  registry.list().map(({ id, kind, label, mime, extension, media }) => ({ id, kind, label, mime, extension, media }))
