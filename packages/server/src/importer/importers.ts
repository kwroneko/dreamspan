import { importPromptPreset } from "../formats/presetSettings.ts"
// The importer registry (PLUGINS §8): each importer reads one family of files into a
// library document. The built-ins register through it as a plugin's importer will. They
// run in a format worker (Formats.ts), never on the main thread, so this registry lives
// in that worker.
import { createHash } from "node:crypto"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import { LoreRole } from "@rp/shared/docs/lorebook.ts"
import { MAX_NOTE_DEPTH, NOTE_SCHEMA_VERSION, noteDepth, type NoteDoc, Placement } from "@rp/shared/docs/note.ts"
import { PRESET_SCHEMA_VERSION } from "@rp/shared/docs/preset.ts"
import { ImportIssue, ImportReport } from "@rp/shared/importReport.ts"
import type { Doc, EntityKind } from "@rp/shared/library.ts"
import { Context, Effect, Layer, Predicate, Schema } from "effect"
import { importCard } from "../formats/cardImport.ts"
import { isStPresetFile } from "../formats/preset.ts"
import { attempt, defaultLimits, type FormatError } from "../formats/safety.ts"
import { AuthorNoteLorePlace, importLorebook } from "../formats/worldInfo.ts"
import { OUR_EXTENSION } from "../formats/lorebook.ts"
import { docHash, searchText } from "../db/documents.ts"
import { makeRegistry, type Registry } from "../registry.ts"
import { type Sniffed, sniff } from "./detect.ts"
import { ParsedFile, ParsedMedia } from "./ops.ts"
import { describeImage } from "./images.ts"
import { validateDoc } from "@rp/shared/editing.ts"
import { AvatarCrop, snapCrop } from "@rp/shared/media.ts"

/** A file that came with an imported one: a card's avatar or an embedded asset. */
interface ImportedFile {
  readonly role: "avatar" | "asset"
  readonly uri: string
  readonly bytes: Uint8Array
}

export interface Imported {
  readonly stCreatedAt?: number | null
  readonly stModifiedAt?: number | null
  /** A card's ST `chat`: the chat file ST last opened it on. */
  readonly stChat?: string | null
  readonly report: ImportReport
  /** Null when the file holds nothing to import, e.g. an unsupported preset kind. */
  readonly library: {
    readonly kind: EntityKind
    readonly label: string
    readonly doc: object
    readonly schemaVersion: number
    /** A card's note, without its owner: the card, which doesn't exist yet. */
    readonly note: Omit<NoteDoc, "owner"> | null
    /** The card's other notes an export carried (`extensions.rp_harness`), without their owner. */
    readonly notes?: ReadonlyArray<Omit<NoteDoc, "owner">>
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
    exportable: true,
    // ST always sends it (DESIGN §4.1).
    on_by_default: true
  }
  return { card: { ...card, extensions }, note, clamped }
}

/** Where a card module without a placement goes: with the definitions (DESIGN §4.1). */
const WITH_THE_DEFINITIONS = { mode: "section", section: "after_main_prompt", role: "system" } as const

/**
 * The card notes an export put in our extension namespace (`extensions.rp_harness.notes`,
 * or `modules` from before card modules became card notes, DESIGN §5.0), out of it. Each
 * keeps its id as `module_id`, so a re-import finds it. `agent_editable` is never read: a
 * file doesn't grant the agent anything (DESIGN §11). Invalid entries are dropped and reported.
 */
const exportedNotes = (card: CardDoc) => {
  const ours = card.extensions[OUR_EXTENSION]
  const issues: Array<ImportIssue> = []
  if (!Predicate.isObject(ours) || (ours.notes === undefined && ours.modules === undefined))
    return { card, notes: [], issues }
  const notes: Array<Omit<NoteDoc, "owner">> = []
  for (const key of ["modules", "notes"] as const) {
    const list = ours[key]
    if (list === undefined) continue
    const items = Array.isArray(list) ? list : [list]
    items.slice(0, MAX_EXPORTED_NOTES).forEach((item, index) => {
      if (
        !Predicate.isObject(item) ||
        !Predicate.isString(item.id) ||
        !Predicate.isString(item.title) ||
        !Predicate.isString(item.content)
      ) {
        issues.push(
          new ImportIssue({
            level: "warning",
            code: "card.invalid_note",
            message: `${key === "modules" ? "Module" : "Note"} ${index} isn't valid; it was dropped.`,
            path: ["data", "extensions", OUR_EXTENSION, key, index]
          })
        )
        return
      }
      // A placement that isn't valid is dropped, so the note goes with the definitions.
      const placement = Schema.is(Placement)(item.placement) ? item.placement : WITH_THE_DEFINITIONS
      notes.push({
        schema_version: NOTE_SCHEMA_VERSION,
        title: item.title,
        content: item.content,
        placement,
        exportable: true,
        module_id: item.id,
        ...(item.scan_lore === true ? { scan_lore: true } : {}),
        ...(item.on_by_default === true ? { on_by_default: true } : {})
      })
    })
  }
  const { notes: _notes, modules: _modules, ...rest } = ours
  const { [OUR_EXTENSION]: _ours, ...extensions } = card.extensions
  return {
    card: { ...card, extensions: Object.keys(rest).length > 0 ? { ...extensions, [OUR_EXTENSION]: rest } : extensions },
    notes,
    issues
  }
}

/**
 * The avatar's cutout an export of ours put in our namespace (`extensions.rp_harness.avatar_crop`,
 * §14.5c), out of it and onto the card, when the file holds the image it was chosen on (the same
 * size: an image ST cropped again is another). The writer binds it to the stored file. ST's
 * cards have none: the default.
 */
const exportedCrop = (card: CardDoc, avatar: Uint8Array | null): CardDoc => {
  const ours = card.extensions[OUR_EXTENSION]
  if (!Predicate.isObject(ours) || ours.avatar_crop === undefined) return card
  const { avatar_crop: carried, ...rest } = ours
  const { [OUR_EXTENSION]: _ours, ...others } = card.extensions
  const extensions = Object.keys(rest).length > 0 ? { ...others, [OUR_EXTENSION]: rest } : others
  const crop = Predicate.isObject(carried)
    ? {
        x: carried.x,
        y: carried.y,
        width: carried.width,
        height: carried.height,
        ...(carried.picture ? { picture: carried.picture } : {})
      }
    : null
  const image = avatar === null ? null : describeImage(avatar)
  const sameImage =
    image !== null &&
    Predicate.isObject(carried) &&
    (carried.image_width === undefined || carried.image_width === image.width) &&
    (carried.image_height === undefined || carried.image_height === image.height)
  return sameImage && Schema.is(AvatarCrop)(crop)
    ? { ...card, extensions, avatar_crop: snapCrop(crop) }
    : { ...card, extensions }
}

/** At most this many notes come in with a card, as the card's other lists are bounded. */
const MAX_EXPORTED_NOTES = 1000

const cardImporter: Importer = {
  id: "card",
  // A JSON card names its spec; a V1 card only has a name, so it's asked last (below).
  detect: (file) => file.container === "png" || file.container === "zip" || file.keys.has("spec"),
  parse: (bytes, fileName) =>
    Effect.map(importCard(bytes), (imported) => {
      const lifted = exportedNotes(exportedCrop(imported.card, imported.avatar?.bytes ?? null))
      const { card, note, clamped } = characterNote(lifted.card)
      const carried = lifted.issues.reduce(withIssue, imported.report)
      const noted = note
        ? withIssue(
            carried,
            new ImportIssue({
              level: "info",
              code: "card.character_note",
              message: "The Character's Note became a note on the card.",
              path: ["data", "extensions", "depth_prompt"]
            })
          )
        : carried
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
        stModifiedAt: imported.stModifiedAt,
        stChat: imported.stChat,
        report,
        library: {
          kind: "card",
          label: labelFrom(card.name, baseName(fileName)),
          doc: card,
          schemaVersion: card.schema_version,
          note,
          notes: lifted.notes
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
    Effect.map(
      Effect.flatMap(AuthorNoteLorePlace, (place) => importLorebook(bytes, baseName(fileName), defaultLimits, place)),
      ({ lorebook, report }) => ({
        report,
        library: {
          kind: "lorebook",
          label: labelFrom(lorebook.name, baseName(fileName)),
          doc: lorebook,
          schemaVersion: lorebook.schema_version,
          note: null
        },
        files: []
      })
    )
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
export const parsedFile = (
  { report, library, files, stCreatedAt, stModifiedAt, stChat }: Imported,
  fileSha256: string
) => {
  // The importers build documents to their schemas, the card's note too; one that came out
  // invalid is an importer bug, and is never stored. The note is checked as a card's, which
  // the writer makes it.
  const docCheck = library && validateDoc(library.kind, library.doc)
  const asCards = [...(library?.note ? [library.note] : []), ...(library?.notes ?? [])].map((note) =>
    validateDoc("note", { ...note, owner: { card: "0190a000-0000-7000-8000-000000000000" } })
  )
  const check = docCheck && !docCheck.ok ? docCheck : asCards.find((c) => !c.ok)
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
    ...(stModifiedAt === undefined ? {} : { stModifiedAt }),
    ...(stChat === undefined || stChat === null ? {} : { stChat }),
    report,
    sha256: fileSha256,
    library: library && {
      kind: library.kind,
      label: library.label,
      ...encoded(library.kind === "preset" && docCheck?.ok ? docCheck.doc : library.doc),
      schemaVersion: library.schemaVersion,
      noteDocJson: library.note && JSON.stringify(library.note),
      ...(library.notes?.length ? { notesDocJson: library.notes.map((note) => JSON.stringify(note)) } : {})
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
