// The format workers' operations (ARCHITECTURE.md §11.2): parsing an uploaded file and
// writing an export, both CPU work on untrusted or large data, kept off the main thread.
import { ImportReport } from "@rp/shared/importReport.ts"
import { EntityKind } from "@rp/shared/library.ts"
import { ExportFormat } from "@rp/shared/libraryImport.ts"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Transferable } from "effect/workers"
import { ImportedMedia, Sha256 } from "../db/ops.ts"

/**
 * The bytes with a buffer of their own, so they can be transferred. A view into a larger
 * buffer is copied: small Node Buffers share a pool, which can't be transferred, and
 * transferring a buffer under other views would empty them.
 */
export const ownBuffer = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes)

/** A file that came with an imported one, as `ImportFile` records it, with its bytes. */
export class ParsedMedia extends Schema.Class<ParsedMedia>("ParsedMedia")({
  ...ImportedMedia.fields,
  bytes: Transferable.Uint8Array
}) {}

/** A parsed file: its report, and what goes into the library, if anything. */
export class ParsedFile extends Schema.Class<ParsedFile>("ParsedFile")({
  report: ImportReport,
  /** Of the file's bytes. */
  sha256: Sha256,
  library: Schema.NullOr(
    Schema.Struct({
      kind: EntityKind,
      label: Schema.String,
      docJson: Schema.String,
      /** The document's content hash and search text, worked out here rather than in the writer. */
      docHash: Schema.String,
      searchText: Schema.String,
      schemaVersion: Schema.Int,
      noteDocJson: Schema.NullOr(Schema.String)
    })
  ),
  media: Schema.Array(ParsedMedia)
}) {}

/** The document can't be written in that format, e.g. it isn't a valid card any more. */
export class ExportRefused extends Schema.TaggedError<ExportRefused>()("ExportRefused", {
  message: Schema.String
}) {}

const ExportedFile = Schema.Struct({ bytes: Transferable.Uint8Array, mime: Schema.String })

export const ExportInput = Schema.Struct({
  format: ExportFormat,
  docJson: Schema.String,
  noteDocJson: Schema.NullOr(Schema.String),
  avatar: Schema.NullOr(ExportedFile),
  /** A card's embedded assets, by the URI its assets name them with. */
  assets: Schema.Array(Schema.Struct({ ...ExportedFile.fields, uri: Schema.String }))
})
export type ExportInput = typeof ExportInput.Type

// --- ST data folder import (ARCHITECTURE.md §13): the folder's files read in a format
// worker, like any upload. Chats come in parts; their messages cross as JSON text in
// batches, which the main thread passes on to the writer without reading.
const StAuthorNote = Schema.Struct({
  content: Schema.String,
  position: Schema.Number,
  depth: Schema.Int,
  role: Schema.Number,
  interval: Schema.Int
})

const StChatHeader = Schema.Struct({
  mainChat: Schema.NullOr(Schema.String),
  persona: Schema.NullOr(Schema.String),
  world: Schema.NullOr(Schema.String),
  authorNote: Schema.NullOr(StAuthorNote),
  variablesJson: Schema.String,
  createdAt: Schema.NullOr(Schema.Number)
})
export type StChatHeader = typeof StChatHeader.Type

const StSpeaker = Schema.Struct({
  key: Schema.String,
  user: Schema.Boolean,
  name: Schema.String,
  avatar: Schema.NullOr(Schema.String)
})
export type StSpeaker = typeof StSpeaker.Type

export class StChatPart extends Schema.Class<StChatPart>("StChatPart")({
  report: ImportReport,
  /** Of the part's bytes. */
  sha256: Sha256,
  header: Schema.NullOr(StChatHeader),
  batches: Schema.Array(Schema.Struct({ messagesJson: Schema.String, speakers: Schema.Array(Schema.String) })),
  messages: Schema.Int,
  userTurns: Schema.Int,
  leadingHidden: Schema.Int,
  speakers: Schema.Array(StSpeaker),
  greeting: Schema.NullOr(Schema.String),
  summaries: Schema.Array(Schema.Struct({ index: Schema.Int, text: Schema.String })),
  lastAt: Schema.NullOr(Schema.Number)
}) {}

const StPersona = Schema.Struct({
  avatar: Schema.String,
  name: Schema.String,
  description: Schema.String,
  position: Schema.Number,
  depth: Schema.Int,
  role: Schema.Number
})
export type StPersona = typeof StPersona.Type

export class StSettings extends Schema.Class<StSettings>("StSettings")({
  personas: Schema.Array(StPersona),
  globalWorlds: Schema.Array(Schema.String),
  characterWorlds: Schema.Array(Schema.Struct({ card: Schema.String, worlds: Schema.Array(Schema.String) })),
  defaultAuthorNote: Schema.NullOr(StAuthorNote),
  summary: Schema.Struct({
    position: Schema.Number,
    depth: Schema.Int,
    role: Schema.Number,
    template: Schema.String,
    enabled: Schema.Boolean
  })
}) {}

export class StGroup extends Schema.Class<StGroup>("StGroup")({
  id: Schema.String,
  name: Schema.String,
  members: Schema.Array(Schema.String),
  disabledMembers: Schema.Array(Schema.String),
  chats: Schema.Array(Schema.String)
}) {}

/** A library file of the folder, and for a card what chats are linked to it by. */
export class StLibraryFile extends Schema.Class<StLibraryFile>("StLibraryFile")({
  parsed: ParsedFile,
  card: Schema.NullOr(
    Schema.Struct({ name: Schema.String, greetings: Schema.Array(Schema.String), world: Schema.NullOr(Schema.String) })
  )
}) {}

export class FormatOps extends RpcGroup.make(
  Rpc.make("Parse", {
    payload: { bytes: Transferable.Uint8Array, fileName: Schema.String },
    success: ParsedFile
  }),
  Rpc.make("Export", { payload: ExportInput, success: Transferable.Uint8Array, error: ExportRefused }),
  // --- ST data folder import
  Rpc.make("ParseStChatPart", {
    payload: {
      bytes: Transferable.Uint8Array,
      first: Schema.Boolean,
      firstIndex: Schema.Int,
      carryAt: Schema.NullOr(Schema.Number)
    },
    success: StChatPart
  }),
  Rpc.make("ParseStSettings", {
    payload: { bytes: Transferable.Uint8Array },
    success: Schema.Struct({ report: ImportReport, settings: Schema.NullOr(StSettings) })
  }),
  Rpc.make("ParseStGroup", {
    payload: { bytes: Transferable.Uint8Array, fileName: Schema.String },
    success: Schema.Struct({ report: ImportReport, group: Schema.NullOr(StGroup) })
  }),
  /** A card, World Info file or preset of the folder; `expect` is the kind its folder holds. */
  Rpc.make("ParseStLibraryFile", {
    payload: { bytes: Transferable.Uint8Array, fileName: Schema.String, expect: EntityKind },
    success: StLibraryFile
  }),
  /** A persona as a card with its avatar; null for an avatar ST lists under no name. */
  Rpc.make("BuildStPersona", {
    payload: { bytes: Transferable.Uint8Array, fileName: Schema.String, persona: Schema.NullOr(StPersona) },
    success: ParsedFile
  })
) {}
