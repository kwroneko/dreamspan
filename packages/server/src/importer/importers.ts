// The importer registry (PLUGINS §8): each importer reads one family of files into a
// library document. The built-ins register through it as a plugin's importer will. They
// run in a format worker (Formats.ts), never on the main thread, so this registry lives
// in that worker.
import { createHash } from "node:crypto"
import { posix } from "node:path"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import { LoreRole } from "@rp/shared/docs/lorebook.ts"
import { NOTE_SCHEMA_VERSION, type NoteDoc } from "@rp/shared/docs/note.ts"
import { PRESET_SCHEMA_VERSION } from "@rp/shared/docs/preset.ts"
import { ImportIssue, ImportReport } from "@rp/shared/importReport.ts"
import type { EntityKind } from "@rp/shared/library.ts"
import { Context, Effect, Layer, Predicate, Schema } from "effect"
import { importCard } from "../formats/cardImport.ts"
import { importStPreset, isStPresetFile } from "../formats/preset.ts"
import { attempt, type FormatError } from "../formats/safety.ts"
import { importLorebook } from "../formats/worldInfo.ts"
import { makeRegistry, type Registry } from "../registry.ts"
import { type Sniffed, sniff } from "./detect.ts"
import { ParsedFile, ParsedMedia } from "./ops.ts"

/** A file that came with an imported one: a card's avatar or an embedded asset. */
interface ImportedFile {
  readonly role: "avatar" | "asset"
  readonly uri: string
  readonly bytes: Uint8Array
}

interface Imported {
  readonly report: ImportReport
  /** Null when the file holds nothing to import, e.g. an unsupported preset kind. */
  readonly library: {
    readonly kind: EntityKind
    readonly label: string
    readonly doc: object
    readonly schemaVersion: number
    /** A card's note, without its owner: the card, which doesn't exist yet. */
    readonly note: Omit<NoteDoc, "owner"> | null
  } | null
  readonly files: ReadonlyArray<ImportedFile>
}

export interface Importer {
  /** The format family, e.g. `card` or `st-world-info`. */
  readonly id: string
  /** Whether this importer reads the file. Importers are asked in registration order. */
  readonly detect: (file: Sniffed) => boolean
  readonly parse: (bytes: Uint8Array, fileName: string) => Effect.Effect<Imported, FormatError>
}

export class Importers extends Context.Service<Importers, Registry<Importer>>()("rp/importer/Importers") {}

const MAX_LABEL = 200

/** A library label from file text: one line, without control characters, bounded. */
const labelFrom = (...candidates: ReadonlyArray<string>) => {
  for (const candidate of candidates) {
    const label = candidate.replace(/\p{Cc}+/gu, " ").trim()
    if (label !== "") return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL)}…` : label
  }
  return "Untitled"
}

/** The file's name without its folder or extension. */
const baseName = (fileName: string) => posix.basename(fileName.replaceAll("\\", "/")).replace(/\.[^.]*$/, "")

const withIssue = (report: ImportReport, issue: ImportIssue) =>
  new ImportReport({ format: report.format, issues: [...report.issues, issue] })

/**
 * ST's Character's Note (`extensions.depth_prompt`) as the card's note (DESIGN §4.1a), out
 * of the card's extensions so it lives in one place. An empty one stays where it was. ST
 * defaults a missing depth to 4 and a missing role to system.
 */
const characterNote = (card: CardDoc) => {
  const { depth_prompt: depthPrompt, ...extensions } = card.extensions
  if (!Predicate.isObject(depthPrompt) || typeof depthPrompt.prompt !== "string" || depthPrompt.prompt === "") {
    return { card, note: null }
  }
  const depth = Number.isSafeInteger(depthPrompt.depth) && (depthPrompt.depth as number) >= 0 ? depthPrompt.depth : 4
  const role = Schema.is(LoreRole)(depthPrompt.role) ? depthPrompt.role : "system"
  const note: Omit<NoteDoc, "owner"> = {
    schema_version: NOTE_SCHEMA_VERSION,
    title: "Character's Note",
    content: depthPrompt.prompt,
    placement: { mode: "depth", depth: depth as number, role },
    exportable: true
  }
  return { card: { ...card, extensions }, note }
}

const cardImporter: Importer = {
  id: "card",
  // A JSON card names its spec; a V1 card only has a name, so it's asked last (below).
  detect: (file) => file.container === "png" || file.container === "zip" || file.keys.has("spec"),
  parse: (bytes, fileName) =>
    Effect.map(importCard(bytes), (imported) => {
      const { card, note } = characterNote(imported.card)
      const report = note
        ? withIssue(
            imported.report,
            new ImportIssue({
              level: "info",
              code: "card.character_note",
              message: "The Character's Note became a note on the card.",
              path: ["data", "extensions", "depth_prompt"]
            })
          )
        : imported.report
      return {
        report,
        library: {
          kind: "card",
          label: labelFrom(card.name, baseName(fileName)),
          doc: card,
          schemaVersion: card.schema_version,
          note
        },
        files: [
          ...(imported.avatar
            ? [{ role: "avatar" as const, uri: imported.avatar.uri, bytes: imported.avatar.bytes }]
            : []),
          ...imported.assets.map((asset) => ({ role: "asset" as const, uri: asset.uri, bytes: asset.bytes }))
        ]
      }
    })
}

const lorebookImporter: Importer = {
  id: "st-world-info",
  detect: (file) => file.keys.has("entries"),
  parse: (bytes, fileName) =>
    Effect.map(importLorebook(bytes, baseName(fileName)), ({ lorebook, report }) => ({
      report,
      library: {
        kind: "lorebook",
        label: labelFrom(lorebook.name, baseName(fileName)),
        doc: lorebook,
        schemaVersion: lorebook.schema_version,
        note: null
      },
      files: []
    }))
}

const presetImporter: Importer = {
  id: "st-preset",
  detect: (file) => isStPresetFile(file.keys),
  // ST names a preset after its file.
  parse: (bytes, fileName) =>
    attempt(() => {
      const { document, report } = importStPreset(bytes)
      return {
        report,
        library: document && {
          kind: "preset",
          label: labelFrom(baseName(fileName)),
          doc: document,
          schemaVersion: PRESET_SCHEMA_VERSION,
          note: null
        },
        files: []
      }
    })
}

const cardV1Importer: Importer = { ...cardImporter, id: "card-v1", detect: (file) => file.keys.has("name") }

/** The registry with the built-in importers registered for the layer's lifetime. */
export const layer = Layer.effect(
  Importers,
  Effect.gen(function* () {
    const registry = makeRegistry<Importer>()
    for (const importer of [cardImporter, lorebookImporter, presetImporter, cardV1Importer]) {
      yield* registry.register(importer)
    }
    return registry
  })
)

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** An image's type from its first bytes, and a PNG's size from its header. */
const describeImage = (bytes: Uint8Array) => {
  const starts = (...prefix: ReadonlyArray<number>) => prefix.every((byte, index) => bytes[index] === byte)
  const ascii = (offset: number, text: string) =>
    Buffer.from(bytes.subarray(offset, offset + text.length)).toString("latin1") === text
  if (starts(0x89, 0x50, 0x4e, 0x47) && ascii(12, "IHDR") && bytes.byteLength >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { mime: "image/png", width: view.getUint32(16), height: view.getUint32(20) }
  }
  const mime = starts(0xff, 0xd8, 0xff)
    ? "image/jpeg"
    : ascii(0, "GIF8")
      ? "image/gif"
      : ascii(0, "RIFF") && ascii(8, "WEBP")
        ? "image/webp"
        : ascii(4, "ftypavif")
          ? "image/avif"
          : ascii(0, "BM")
            ? "image/bmp"
            : "application/octet-stream"
  return { mime, width: null, height: null }
}

const failed = (format: string, code: string, message: string) =>
  new ImportReport({ format, issues: [new ImportIssue({ level: "error", code, message })] })

/**
 * Reads a file with the first importer that detects it. Never fails: a file that can't be
 * imported is a report with an error and nothing for the library.
 */
export const parseFile = (bytes: Uint8Array, fileName: string) =>
  Effect.gen(function* () {
    const registry = yield* Importers
    const file = sniff(bytes)
    const importer = registry.list().find((entry) => entry.detect(file))
    const imported: Imported = importer
      ? yield* importer
          .parse(bytes, fileName)
          .pipe(
            Effect.catchTag("FormatError", (error) =>
              Effect.succeed({ report: failed(importer.id, error.code, error.message), library: null, files: [] })
            )
          )
      : {
          report: failed(
            "unknown",
            "file.unrecognized",
            "This isn't a character card, World Info file or chat-completion preset that this app can import."
          ),
          library: null,
          files: []
        }
    const { library } = imported
    return new ParsedFile({
      report: imported.report,
      sha256: sha256(bytes),
      library: library && {
        kind: library.kind,
        label: library.label,
        docJson: JSON.stringify(library.doc),
        schemaVersion: library.schemaVersion,
        noteDocJson: library.note && JSON.stringify(library.note)
      },
      media: library
        ? imported.files.map(
            (entry) =>
              new ParsedMedia({
                role: entry.role,
                uri: entry.uri,
                sha256: sha256(entry.bytes),
                byteSize: entry.bytes.byteLength,
                ...describeImage(entry.bytes),
                // A copy with its own buffer: the bytes may be a view into the upload or into
                // Node's shared pool, and they're transferred to the main thread.
                bytes: new Uint8Array(entry.bytes)
              })
          )
        : []
    })
  })
