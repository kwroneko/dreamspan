// Card import: a file's bytes to our card document, the images it carries, and its import
// report. The format is detected from the bytes, never trusted from the file name.
import { formatByteSize } from "@dreamspan/shared/byteSize.ts"
import { sourceTime } from "./sourceTime.ts"
import type { CardDoc } from "@dreamspan/shared/docs/card.ts"
import { type ImportReport, ReportBuilder, shownText } from "@dreamspan/shared/importReport.ts"
import type { Effect } from "effect"
import { posix } from "node:path"
import { describeImage } from "../importer/images.ts"
import { cardFromJson } from "./card.ts"
import { ASSET_KEYWORD, decodeCardText, isPng, readChunks, replaceCardChunks, splitText } from "./png.ts"
import { attempt, defaultLimits, fail, type FormatError, type Limits, parseJson } from "./safety.ts"
import { extract, isZip, readZip } from "./zip.ts"

/** A file that came with the card. `uri` is how the card's `assets` refer to it. */
export interface CardFile {
  readonly uri: string
  readonly ext: string
  readonly bytes: Uint8Array
}

export interface CardImport {
  readonly stCreatedAt: number | null
  /** CCv3 modification_date (seconds), else the consumed CHARX entries’ times. */
  readonly stModifiedAt: number | null
  /** ST's `chat`: the chat file ST last opened the card on. */
  readonly stChat: string | null
  readonly card: CardDoc
  readonly avatar: CardFile | null
  /** Embedded assets other than the avatar. */
  readonly assets: ReadonlyArray<CardFile>
  readonly report: ImportReport
}

/**
 * ST's reading: `ccv3` wins over `chara` when both are there, keywords match in any case,
 * and the first chunk with a keyword counts. The avatar is the PNG without its card chunks.
 */
const fromPng = (bytes: Uint8Array, limits: Limits, issues: ReportBuilder) => {
  const chunks = readChunks(bytes, limits)
  const texts = chunks.flatMap((chunk) => (chunk.type === "tEXt" ? [splitText(chunk.data)] : []))
  const named = (keyword: string) => texts.find((text) => text.keyword.toLowerCase() === keyword)
  const source = named("ccv3") ?? named("chara")
  if (!source) return fail("png.no_card", "The PNG has no character card in it.")
  if (texts.some((text) => text.keyword.startsWith(ASSET_KEYWORD))) {
    issues.add("info", "png.assets_ignored", "Assets in PNG text chunks aren't supported; they were skipped.")
  }
  const card = cardFromJson(
    parseJson(decodeCardText(source.payload, limits), limits.maxCardJsonBytes, limits, issues),
    limits,
    issues
  )
  const avatar: CardFile = { uri: "ccdefault:", ext: "png", bytes: replaceCardChunks(chunks) }
  return { ...card, avatar }
}

// ST's: RisuAI writes `embeded://`, the spec's spelling; `__asset:` is the PNG chunk form.
const EMBEDDED_PREFIXES = ["embeded://", "embedded://", "__asset:"]
// ST's image formats for CHARX assets. Other assets (audio, models, Risu scripts) are skipped.
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "apng", "avif", "bmp", "jfif"])

/** The archive path an asset URI names, normalized as ST does, or undefined. */
export const embeddedPath = (uri: string) => {
  const trimmed = uri.trim()
  const prefix = EMBEDDED_PREFIXES.find((p) => trimmed.toLowerCase().startsWith(p))
  if (prefix === undefined) return undefined
  return posix.normalize(trimmed.slice(prefix.length).replace(/^(\.\/)+/, "")).replace(/^\/+/, "")
}

/**
 * A zip with `card.json` and its assets. ST takes the first entry whose name ends in
 * `card.json`; the spec puts it at the root, so the root one wins when both exist. The
 * avatar is the main icon, as in ST's `pickCharXIconAsset`.
 */
const fromCharx = (bytes: Uint8Array, limits: Limits, issues: ReportBuilder) => {
  const entries = readZip(bytes, limits)
  const names = [...entries.keys()]
  const cardName =
    names.find((name) => name === "card.json") ??
    names.find((name) => name.endsWith("card.json") && !name.startsWith("__MACOSX"))
  if (cardName === undefined) return fail("charx.no_card", "The archive has no card.json.")
  const budget = { used: 0 }
  const parsed = cardFromJson(
    parseJson(extract(bytes, entries.get(cardName)!, limits, budget), limits.maxCardJsonBytes, limits, issues),
    limits,
    issues
  )
  if (parsed.version === "v1") fail("charx.no_card", "The archive's card.json has no spec.")

  const used = new Set([cardName])
  const files: Array<CardFile & { type: string; name: string }> = []
  parsed.card.assets?.forEach((asset, index) => {
    const path = embeddedPath(asset.uri)
    if (path === undefined) return
    const ext = (asset.ext.trim().replace(/^\./, "") || posix.extname(path).slice(1)).toLowerCase()
    const entry = entries.get(path)
    if (entry === undefined) {
      issues.add("warning", "charx.missing_asset", `The asset "${shownText(asset.name)}" isn't in the archive.`, [
        "data",
        "assets",
        index
      ])
    } else if (!IMAGE_EXTS.has(ext)) {
      issues.add(
        "info",
        "charx.asset_skipped",
        `The asset "${shownText(asset.name)}" isn't an image; it was skipped.`,
        ["data", "assets", index]
      )
    } else if (!used.has(path)) {
      used.add(path)
      const data = extract(bytes, entry, limits, budget)
      if (describeImage(data).mime === "application/octet-stream") {
        issues.add(
          "warning",
          "charx.asset_skipped",
          `The asset "${shownText(asset.name)}" isn't an image; it was skipped.`,
          ["data", "assets", index]
        )
        return
      }
      files.push({
        uri: asset.uri,
        ext,
        bytes: data,
        type: asset.type,
        name: asset.name
      })
    }
  })
  const icons = files.filter((file) => file.type.toLowerCase() === "icon")
  const icon = icons.find((file) => file.name.toLowerCase() === "main") ?? icons[0]
  const unused = names.filter((name) => !used.has(name)).length
  if (unused > 0) issues.add("info", "charx.unused_files", `${unused} files in the archive weren't used.`)
  const plain = ({ uri, ext, bytes }: CardFile) => ({ uri, ext, bytes })
  return {
    ...parsed,
    archiveModifiedAt: [...used].reduce<number | null>((latest, name) => {
      const at = entries.get(name)?.modifiedAt ?? null
      return at === null ? latest : Math.max(latest ?? 0, at)
    }, null),
    avatar: icon ? plain(icon) : null,
    assets: files.filter((file) => file !== icon).map(plain)
  }
}

const cardModifiedAt = (card: CardDoc) =>
  typeof card.modification_date === "number" && card.modification_date > 0
    ? sourceTime(card.modification_date * 1000)
    : null

export const importCard = (bytes: Uint8Array, limits: Limits = defaultLimits): Effect.Effect<CardImport, FormatError> =>
  attempt(() => {
    if (bytes.byteLength > limits.maxFileBytes) {
      fail("file.too_large", `The file is larger than ${formatByteSize(limits.maxFileBytes)}.`)
    }
    const issues = new ReportBuilder()
    const report = (version: string, container: string) => issues.build(`card-${version}-${container}`)
    if (isPng(bytes)) {
      const { card, version, avatar, stCreatedAt, stChat } = fromPng(bytes, limits, issues)
      return {
        card,
        stCreatedAt,
        stModifiedAt: cardModifiedAt(card),
        stChat,
        avatar,
        assets: [],
        report: report(version, "png")
      }
    }
    if (isZip(bytes)) {
      const { card, version, avatar, assets, stCreatedAt, stChat, archiveModifiedAt } = fromCharx(bytes, limits, issues)
      return {
        card,
        stCreatedAt,
        stModifiedAt: cardModifiedAt(card) ?? archiveModifiedAt,
        stChat,
        avatar,
        assets,
        report: report(version, "charx")
      }
    }
    const { card, version, stCreatedAt, stChat } = cardFromJson(
      parseJson(bytes, limits.maxCardJsonBytes, limits, issues),
      limits,
      issues
    )
    return {
      card,
      stCreatedAt,
      stModifiedAt: cardModifiedAt(card),
      stChat,
      avatar: null,
      assets: [],
      report: report(version, "json")
    }
  })
