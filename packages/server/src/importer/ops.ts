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

export class FormatOps extends RpcGroup.make(
  Rpc.make("Parse", {
    payload: { bytes: Transferable.Uint8Array, fileName: Schema.String },
    success: ParsedFile
  }),
  Rpc.make("Export", { payload: ExportInput, success: Transferable.Uint8Array, error: ExportRefused })
) {}
