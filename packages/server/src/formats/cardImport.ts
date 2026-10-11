// Card import: a file's bytes to our card document, the images it carries, and its import
// report. The format is detected from the bytes, never trusted from the file name.
import type { CardDoc } from "@rp/shared/docs/card.ts"
import { ImportReport } from "@rp/shared/importReport.ts"
import type { Effect } from "effect"
import { cardFromJson } from "./card.ts"
import { decodeText, isPng, readChunks } from "./png.ts"
import { attempt, defaultLimits, fail, type FormatError, Issues, type Limits, parseJson } from "./safety.ts"

/** A file that came with the card. `uri` is how the card's `assets` refer to it. */
export interface CardFile {
  readonly uri: string
  readonly ext: string
  readonly bytes: Uint8Array
}

export interface CardImport {
  readonly card: CardDoc
  readonly avatar: CardFile | null
  /** Embedded assets other than the avatar. */
  readonly assets: ReadonlyArray<CardFile>
  readonly report: ImportReport
}

const ASSET_CHUNK = "chara-ext-asset_"
const isCardChunk = (keyword: string) =>
  keyword.toLowerCase() === "ccv3" || keyword.toLowerCase() === "chara" || keyword.startsWith(ASSET_CHUNK)

/**
 * ST's reading: `ccv3` wins over `chara` when both are there, keywords match in any case,
 * and the first chunk with a keyword counts. The avatar is the PNG without its card chunks.
 */
const fromPng = (bytes: Uint8Array, limits: Limits, issues: Issues) => {
  const chunks = readChunks(bytes, limits)
  const texts = chunks.flatMap((chunk) => (chunk.type === "tEXt" ? [{ chunk, ...decodeText(chunk.data) }] : []))
  const named = (keyword: string) => texts.find((text) => text.keyword.toLowerCase() === keyword)
  const source = named("ccv3") ?? named("chara")
  if (!source) return fail("png.no_card", "The PNG has no character card in it.")
  if (texts.some((text) => text.keyword.startsWith(ASSET_CHUNK))) {
    issues.info("png.assets_ignored", "Assets in PNG text chunks aren't supported; they were skipped.")
  }
  const cardChunks = new Set(texts.filter((text) => isCardChunk(text.keyword)).map((text) => text.chunk))
  const kept = chunks.filter((chunk) => !cardChunks.has(chunk)).map((chunk) => chunk.raw)
  const avatar: CardFile = { uri: "ccdefault:", ext: "png", bytes: Buffer.concat([bytes.subarray(0, 8), ...kept]) }
  return { ...cardFromJson(parseJson(Buffer.from(source.text, "base64"), limits, issues), issues), avatar }
}

export const importCard = (bytes: Uint8Array, limits: Limits = defaultLimits): Effect.Effect<CardImport, FormatError> =>
  attempt(() => {
    if (bytes.byteLength > limits.maxFileBytes) {
      fail("file.too_large", `The file is larger than ${limits.maxFileBytes} bytes.`)
    }
    const issues = new Issues()
    const report = (version: string, container: string) =>
      new ImportReport({ format: `card-${version}-${container}`, issues: issues.list })
    if (isPng(bytes)) {
      const { card, version, avatar } = fromPng(bytes, limits, issues)
      return { card, avatar, assets: [], report: report(version, "png") }
    }
    const { card, version } = cardFromJson(parseJson(bytes, limits, issues), issues)
    return { card, avatar: null, assets: [], report: report(version, "json") }
  })
