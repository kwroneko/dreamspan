// Library documents back out as files (ARCHITECTURE.md §11.4), in the format worker: a
// large lorebook takes as long to write as to read.
import { CardDoc } from "@rp/shared/docs/card.ts"
import { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import { NoteDoc } from "@rp/shared/docs/note.ts"
import { PresetDoc } from "@rp/shared/docs/preset.ts"
import { Effect, Schema } from "effect"
import { exportCardCharx, exportCardJson, exportCardPng } from "../formats/cardExport.ts"
import { exportStPreset } from "../formats/preset.ts"
import { exportLorebook } from "../formats/worldInfo.ts"
import { type ExportInput, ExportRefused } from "./ops.ts"

/** A 1×1 PNG for a card without a PNG avatar, since a PNG card needs an image to live in. */
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

/** ST's Character's Note from the card's note, if it's exportable (DESIGN §4.1a). */
const withCharacterNote = (card: CardDoc, noteDocJson: string | null) =>
  Effect.gen(function* () {
    if (noteDocJson === null) return card
    const note = yield* decode(NoteDoc, "card's note")(noteDocJson)
    if (!note.exportable) return card
    const depthPrompt = { prompt: note.content, depth: note.placement.depth, role: note.placement.role }
    return { ...card, extensions: { ...card.extensions, depth_prompt: depthPrompt } }
  })

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 4))

const exportCard = (input: ExportInput) =>
  Effect.gen(function* () {
    const card = yield* withCharacterNote(yield* decode(CardDoc, "card")(input.docJson), input.noteDocJson)
    switch (input.format) {
      case "card-v2-json":
        return exportCardJson(card, "v2")
      case "card-v3-json":
        return exportCardJson(card, "v3")
      case "card-png": {
        const image = input.avatar?.mime === "image/png" ? input.avatar.bytes : PLACEHOLDER_PNG
        return yield* exportCardPng(card, image).pipe(
          Effect.mapError(() => new ExportRefused({ message: "The card's avatar isn't a valid PNG." }))
        )
      }
      default: {
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
      }
    }
  })

export const exportFile = (input: ExportInput): Effect.Effect<Uint8Array, ExportRefused> => {
  switch (input.format) {
    case "st-world-info":
      return Effect.map(decode(LorebookDoc, "lorebook")(input.docJson), exportLorebook)
    case "st-preset":
      return Effect.map(decode(PresetDoc, "preset")(input.docJson), (doc) => json(exportStPreset(doc)))
    default:
      return exportCard(input)
  }
}
