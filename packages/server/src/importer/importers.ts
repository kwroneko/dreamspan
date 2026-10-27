import { importPromptPreset } from "../formats/presetSettings.ts"
// The importer registry (PLUGINS §8): each importer reads one family of files into a
// library document. The built-ins register through it as a plugin's importer will. They
// run in a format worker (Formats.ts), never on the main thread, so this registry lives
// in that worker.
import { createHash } from "node:crypto"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import { LoreRole } from "@rp/shared/docs/lorebook.ts"
import { MAX_NOTE_DEPTH, NOTE_SCHEMA_VERSION, noteDepth, type NoteDoc } from "@rp/shared/docs/note.ts"
import { PRESET_SCHEMA_VERSION } from "@rp/shared/docs/preset.ts"
import { ImportIssue, ImportReport } from "@rp/shared/importReport.ts"
import type { Doc, EntityKind } from "@rp/shared/library.ts"
import { Context, Effect, Layer, Predicate, Schema } from "effect"
import { importCard } from "../formats/cardImport.ts"
import { isStPresetFile } from "../formats/preset.ts"
import { attempt, type FormatError } from "../formats/safety.ts"
import { importLorebook } from "../formats/worldInfo.ts"
import { docHash, searchText } from "../db/documents.ts"
import { makeRegistry, type Registry } from "../registry.ts"
import { type Sniffed, sniff } from "./detect.ts"
import { ParsedFile, ParsedMedia } from "./ops.ts"
import { describeImage } from "./images.ts"
import { validateDoc } from "@rp/shared/editing.ts"

/** A file that came with an imported one: a card's avatar or an embedded asset. */
interface ImportedFile {
  readonly role: "avatar" | "asset"
  readonly uri: string
  readonly bytes: Uint8Array
}

export interface Imported {
  readonly stCreatedAt?: number | null
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

/** The file's name without its extension; the upload route has already dropped any folders. */
const baseName = (fileName: string) => fileName.replace(/\.[^.]*$/, "")

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
    return { card, note: null, clamped: null }
  }
  // A depth past ST's limit goes to the limit, as deep as ST puts anything; one that isn't a
  // whole number from 0 takes ST's default. Either is reported.
  const depth = noteDepth(depthPrompt.depth)
  const clamped = depthPrompt.depth === undefined || depthPrompt.depth === depth ? null : depth
  const role = Schema.is(LoreRole)(depthPrompt.role) ? depthPrompt.role : "system"
  const note: Omit<NoteDoc, "owner"> = {
    schema_version: NOTE_SCHEMA_VERSION,
    title: "Character's Note",
    content: depthPrompt.prompt,
    placement: { mode: "depth", depth, role },
    exportable: true
  }
  return { card: { ...card, extensions }, note, clamped }
}

const cardImporter: Importer = {
  id: "card",
  // A JSON card names its spec; a V1 card only has a name, so it's asked last (below).
  detect: (file) => file.container === "png" || file.container === "zip" || file.keys.has("spec"),
  parse: (bytes, fileName) =>
    Effect.map(importCard(bytes), (imported) => {
      const { card, note, clamped } = characterNote(imported.card)
      const noted = note
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
      const report =
        clamped === null
          ? noted
          : withIssue(
              noted,
              new ImportIssue({
                level: "warning",
                code: "card.character_note_depth",
                message: `The Character's Note's depth isn't one ST uses (0 to ${MAX_NOTE_DEPTH}), so it's at depth ${clamped}.`,
                path: ["data", "extensions", "depth_prompt", "depth"]
              })
            )
      return {
        stCreatedAt: imported.stCreatedAt,
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
      const { document, report } = importPromptPreset(bytes)
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

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/**
 * The document as JSON, with its hash and search text, worked out here so the writer, which
 * every user's writes wait on, only stores them. Of the document read back from its JSON,
 * so they're what the writer would work out from it.
 */
const encoded = (doc: object) => {
  const docJson = JSON.stringify(doc)
  const stored = JSON.parse(docJson) as Doc
  return { docJson, docHash: docHash(stored), searchText: searchText(stored) }
}

export const failed = (format: string, code: string, message: string) =>
  new ImportReport({ format, issues: [new ImportIssue({ level: "error", code, message })] })

/** What a parse returns for an imported file whose bytes hash to `fileSha256`. */
export const parsedFile = ({ report, library, files, stCreatedAt }: Imported, fileSha256: string) => {
  // The importers build documents to their schemas, the card's note too; one that came out
  // invalid is an importer bug, and is never stored. The note is checked as a card's, which
  // the writer makes it.
  const docCheck = library && validateDoc(library.kind, library.doc)
  const noteCheck =
    library?.note && validateDoc("note", { ...library.note, owner: { card: "0190a000-0000-7000-8000-000000000000" } })
  const check = docCheck && !docCheck.ok ? docCheck : noteCheck
  if (check && !check.ok) {
    return new ParsedFile({
      report: failed(
        report.format,
        "file.invalid_document",
        `This file can't be imported: reading it gave a document that isn't valid (${check.problems.slice(0, 3).join("; ")}).`
      ),
      sha256: fileSha256,
      library: null,
      media: []
    })
  }
  return new ParsedFile({
    ...(stCreatedAt === undefined ? {} : { stCreatedAt }),
    report,
    sha256: fileSha256,
    library: library && {
      kind: library.kind,
      label: library.label,
      ...encoded(library.doc),
      schemaVersion: library.schemaVersion,
      noteDocJson: library.note && JSON.stringify(library.note)
    },
    media: library
      ? files.map(
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
}

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
    return parsedFile(imported, sha256(bytes))
  })
