// Card export: our card document flattened to a standard V2 or V3 card, as JSON, inside a
// PNG, or as CHARX. The card's notes are added before (importer/exporters.ts).
import type { CardAsset, CardDoc } from "@rp/shared/docs/card.ts"
import type { Effect } from "effect"
import { type CardFile, embeddedPath } from "./cardImport.ts"
import { present } from "./fields.ts"
import { characterBookFromLorebook } from "./lorebook.ts"
import { cardTextChunk, readChunks, replaceCardChunks } from "./png.ts"
import { attempt, defaultLimits, type FormatError, type Limits } from "./safety.ts"
import { isSafePath, writeZip } from "./zip.ts"

export type ExportVersion = "v2" | "v3"

/**
 * The card as V2 or V3 JSON. Both carry the same `data`, V3's fields included, as ST's
 * two PNG chunks do; V2 adds the V1 fields at the top level for V1 readers. Fields the
 * specs don't define go back where they came from, and never override a defined one.
 */
export const cardToJson = (card: CardDoc, version: ExportVersion) => {
  const data = {
    ...card.unknown_fields,
    name: card.name,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    first_mes: card.first_mes,
    mes_example: card.mes_example,
    creator_notes: card.creator_notes,
    system_prompt: card.system_prompt,
    post_history_instructions: card.post_history_instructions,
    alternate_greetings: card.alternate_greetings,
    group_only_greetings: card.group_only_greetings,
    tags: card.tags,
    creator: card.creator,
    character_version: card.character_version,
    ...present({
      character_book: card.character_book && characterBookFromLorebook(card.character_book),
      nickname: card.nickname,
      creator_notes_multilingual: card.creator_notes_multilingual,
      source: card.source,
      creation_date: card.creation_date,
      modification_date: card.modification_date,
      assets: card.assets
    }),
    extensions: card.extensions
  }
  const v1 = {
    name: card.name,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    first_mes: card.first_mes,
    mes_example: card.mes_example
  }
  return version === "v2"
    ? { ...card.unknown_root_fields, ...v1, spec: "chara_card_v2", spec_version: "2.0", data }
    : { ...card.unknown_root_fields, spec: "chara_card_v3", spec_version: "3.0", data }
}

export const exportCardJson = (card: CardDoc, version: ExportVersion) =>
  new TextEncoder().encode(JSON.stringify(cardToJson(card, version), null, 4))

/**
 * The card inside `image`, a PNG, as ST writes it: any card chunks already there are
 * removed, then `chara` (V2) and `ccv3` (V3) go in before IEND.
 */
export const exportCardPng = (
  card: CardDoc,
  image: Uint8Array,
  limits: Limits = defaultLimits
): Effect.Effect<Uint8Array, FormatError> =>
  attempt(() =>
    replaceCardChunks(readChunks(image, limits), [
      cardTextChunk("chara", JSON.stringify(cardToJson(card, "v2"))),
      cardTextChunk("ccv3", JSON.stringify(cardToJson(card, "v3")))
    ])
  )

const isMainIcon = (asset: CardAsset) => asset.type.toLowerCase() === "icon" && asset.name.toLowerCase() === "main"

/**
 * A V3 CHARX: `card.json`, the avatar as the main icon (at its own path when it came from a
 * CHARX), and the embedded assets whose files are given (matched by URI). An embedded asset
 * without a file, or whose path is unsafe or already taken, is left out of the card, since
 * it would point at nothing; every name in the archive is unique.
 */
export const exportCardCharx = (card: CardDoc, files: { avatar: CardFile | null; assets: ReadonlyArray<CardFile> }) => {
  const byUri = new Map(files.assets.map((file) => [file.uri, file]))
  const names = new Set(["card.json"])
  const entries: Array<{ name: string; data: Uint8Array; deflate: boolean }> = []
  const add = (path: string, data: Uint8Array) => {
    if (!isSafePath(path) || names.has(path)) return false
    names.add(path)
    entries.push({ name: path, data, deflate: false })
    return true
  }
  const assets: Array<CardAsset> = []
  if (files.avatar) {
    const ext = /^[a-z0-9]{1,10}$/.test(files.avatar.ext) ? files.avatar.ext : "png"
    const own = embeddedPath(files.avatar.uri)
    const path = own !== undefined && add(own, files.avatar.bytes) ? own : `assets/icon/images/main.${ext}`
    if (path !== own) add(path, files.avatar.bytes)
    assets.push({ type: "icon", uri: `embeded://${path}`, name: "main", ext })
  }
  for (const asset of card.assets ?? []) {
    if (files.avatar && isMainIcon(asset)) continue
    const path = embeddedPath(asset.uri)
    const file = byUri.get(asset.uri)
    if (path === undefined) assets.push(asset)
    else if (file && add(path, file.bytes)) assets.push(asset)
  }
  const json = cardToJson({ ...card, ...(card.assets || files.avatar ? { assets } : {}) }, "v3")
  return writeZip([
    { name: "card.json", data: new TextEncoder().encode(JSON.stringify(json)), deflate: true },
    ...entries
  ])
}
