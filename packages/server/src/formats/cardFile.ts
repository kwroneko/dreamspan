// A character card attached as a file (spec/WORKSHOP-CARDS.md §4.5): recognised by its bytes
// with the import parsers, read as our card document, and edited in place in its own format.
// An edit changes only the fields it names, in the card's own JSON: every other field, unknown
// ones and extensions included, stays as it was, and a PNG keeps its image and its other chunks
// (a CHARX its other entries). Runs in the format worker.
import type { CardDoc } from "@dreamspan/shared/docs/card.ts"
import { ReportBuilder } from "@dreamspan/shared/importReport.ts"
import { Predicate } from "effect"
import { cardFromJson } from "./card.ts"
import { cardTextChunk, decodeText, isPng, readChunks } from "./png.ts"
import { defaultLimits, FormatError, type Limits, parseJson } from "./safety.ts"
import { extract, isZip, readZip, writeZip } from "./zip.ts"

export type CardFileFormat = "png" | "json" | "charx"

export interface CardFileInfo {
  readonly format: CardFileFormat
  /** The card's `spec` ("chara_card_v2", "chara_card_v3"), or "" for a V1 card. */
  readonly spec: string
  readonly specVersion: string
  readonly name: string
  readonly doc: CardDoc
}

/** The fields an edit can change, by the names `edit_card` uses (and the card JSON's own). */
const TEXT_FIELDS = [
  "name",
  "nickname",
  "character_version",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "system_prompt",
  "post_history_instructions",
  "creator_notes",
  "creator"
] as const
const ALIASES: Record<string, string> = { first_message: "first_mes", example_messages: "mes_example" }

export interface CardFileChange {
  readonly field: string
  readonly text?: string
  readonly find?: string
  readonly replace?: string
  readonly items?: ReadonlyArray<string>
}

type Json = Record<string, unknown>

/** The card JSON (the root) a file holds, where its fields are, and how to put it back. */
interface Located {
  readonly format: CardFileFormat
  /** Each copy of the card in the file: a PNG can carry both `chara` and `ccv3`. */
  readonly roots: ReadonlyArray<Json>
  readonly write: (roots: ReadonlyArray<Json>) => Uint8Array
}

const fieldsOf = (root: Json): Json => (root.spec !== undefined && Predicate.isObject(root.data) ? root.data : root)

/** Same indentation as the original, so a JSON card's diff in Files stays small. */
const indentOf = (text: string) => {
  const match = /\n([ \t]+)"/.exec(text)
  return match ? match[1]! : text.includes("\n") ? "  " : ""
}

const locate = (bytes: Uint8Array, limits: Limits): Located | null => {
  const issues = new ReportBuilder()
  if (isPng(bytes)) {
    const chunks = readChunks(bytes, limits)
    const cards = chunks.flatMap((chunk, index) => {
      if (chunk.type !== "tEXt") return []
      const { keyword, text } = decodeText(chunk.data)
      const lower = keyword.toLowerCase()
      if (lower !== "chara" && lower !== "ccv3") return []
      const root = parseJson(Buffer.from(text, "base64"), limits.maxCardJsonBytes, limits, issues)
      return Predicate.isObject(root) ? [{ index, keyword, root: root as Json }] : []
    })
    if (cards.length === 0) return null
    // ST reads `ccv3` first: it's the one shown, the others are edited the same way.
    const ordered = [...cards].sort(
      (a, b) => Number(b.keyword.toLowerCase() === "ccv3") - Number(a.keyword.toLowerCase() === "ccv3")
    )
    return {
      format: "png",
      roots: ordered.map((card) => card.root),
      write: (roots) => {
        const replaced = new Map(
          ordered.map((card, i) => [card.index, cardTextChunk(card.keyword, JSON.stringify(roots[i]))])
        )
        return Buffer.concat([bytes.subarray(0, 8), ...chunks.map((chunk, index) => replaced.get(index) ?? chunk.raw)])
      }
    }
  }
  if (isZip(bytes)) {
    const entries = readZip(bytes, limits)
    const names = [...entries.keys()]
    const cardName =
      names.find((name) => name === "card.json") ??
      names.find((name) => name.endsWith("card.json") && !name.startsWith("__MACOSX"))
    if (cardName === undefined) return null
    const budget = { used: 0 }
    const text = Buffer.from(extract(bytes, entries.get(cardName)!, limits, budget)).toString("utf8")
    const root = parseJson(Buffer.from(text, "utf8"), limits.maxCardJsonBytes, limits, issues)
    if (!Predicate.isObject(root)) return null
    return {
      format: "charx",
      roots: [root as Json],
      write: ([edited]) =>
        writeZip(
          names.map((name) => {
            const entry = entries.get(name)!
            return name === cardName
              ? { name, data: Buffer.from(JSON.stringify(edited, null, indentOf(text)), "utf8"), deflate: true }
              : { name, data: extract(bytes, entry, limits, budget), deflate: entry.method === 8 }
          })
        )
    }
  }
  const text = Buffer.from(bytes).toString("utf8")
  const trimmed = text.trimStart()
  if (!trimmed.startsWith("{")) return null
  const root = parseJson(bytes, limits.maxCardJsonBytes, limits, issues)
  if (!Predicate.isObject(root)) return null
  const bom = text.charCodeAt(0) === 0xfeff ? "﻿" : ""
  const newline = text.endsWith("\n") ? "\n" : ""
  return {
    format: "json",
    roots: [root as Json],
    write: ([edited]) => Buffer.from(`${bom}${JSON.stringify(edited, null, indentOf(text))}${newline}`, "utf8")
  }
}

/** What a card file is, or null when the bytes aren't a card (a plain PNG, other JSON, a zip). */
export const readCardFile = (bytes: Uint8Array, limits: Limits = defaultLimits): CardFileInfo | null => {
  try {
    if (bytes.byteLength > limits.maxFileBytes) return null
    const located = locate(bytes, limits)
    if (located === null) return null
    const root = located.roots[0]!
    // The parser takes fields off what it reads: it gets a copy.
    const { card } = cardFromJson(structuredClone(root), limits, new ReportBuilder())
    return {
      format: located.format,
      spec: typeof root.spec === "string" ? root.spec : "",
      specVersion: typeof root.spec_version === "string" ? root.spec_version : "",
      name: card.name,
      doc: card
    }
  } catch {
    return null
  }
}

/** One card's fields with the changes made, or why they can't be. */
const applied = (
  fields: Json,
  changes: ReadonlyArray<CardFileChange>,
  v1: boolean
): { fields: Json } | { error: string } => {
  const out: Json = { ...fields }
  for (const change of changes) {
    const canonical = ALIASES[change.field] ?? change.field
    if (change.items !== undefined) {
      if (canonical !== "alternate_greetings") return { error: "Only alternate_greetings takes a list of items." }
      out[canonical] = [...change.items]
      continue
    }
    if (!(TEXT_FIELDS as ReadonlyArray<string>).includes(canonical))
      return { error: `The text field ${change.field} cannot be edited by this tool.` }
    const field = v1 && canonical === "creator_notes" && out.creatorcomment != null ? "creatorcomment" : canonical
    if (change.text !== undefined) out[field] = change.text
    else {
      const current = typeof out[field] === "string" ? (out[field] as string) : ""
      if (!change.find || current.split(change.find).length !== 2)
        return { error: `Find must occur exactly once in ${canonical}. Read the card file again.` }
      out[field] = current.replace(change.find, () => change.replace ?? "")
    }
  }
  return { fields: out }
}

export interface CardFileEdit {
  readonly bytes: Uint8Array
  readonly before: CardFileInfo
  readonly after: CardFileInfo
}

/** The file with the changes made in its own format, or why they can't be. */
export const editCardFile = (
  bytes: Uint8Array,
  changes: ReadonlyArray<CardFileChange>,
  limits: Limits = defaultLimits
): CardFileEdit | { readonly error: string } => {
  const before = readCardFile(bytes, limits)
  const located = before === null ? null : locate(bytes, limits)
  if (before === null || located === null) return { error: "The file isn't a character card." }
  const roots: Array<Json> = []
  for (const root of located.roots) {
    const fields = fieldsOf(root)
    const result = applied(fields, changes, fields === root)
    if ("error" in result) return result
    roots.push(fields === root ? result.fields : { ...root, data: result.fields })
  }
  let written: Uint8Array
  try {
    written = located.write(roots)
  } catch (error) {
    if (error instanceof FormatError) return { error: error.message }
    throw error
  }
  const after = readCardFile(written, limits)
  if (after === null) return { error: "The edited card could not be read back." }
  return { bytes: written, before, after }
}
