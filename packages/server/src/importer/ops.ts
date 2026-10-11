// The format workers' operations (ARCHITECTURE.md §10.2): parsing an uploaded file and
// writing an export, both CPU work on untrusted or large data, kept off the main thread.
import { ImportReport } from "@rp/shared/importReport.ts"
import { EntityKind } from "@rp/shared/library.ts"
import { ExportFormat } from "@rp/shared/libraryImport.ts"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Transferable } from "effect/workers"

/**
 * The bytes with a buffer of their own, so they can be transferred. A view into a larger
 * buffer is copied: small Node Buffers share a pool, which can't be transferred, and
 * transferring a buffer under other views would empty them.
 */
export const ownBuffer = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes)

export class ParsedMedia extends Schema.Class<ParsedMedia>("ParsedMedia")({
  role: Schema.Literals(["avatar", "asset"]),
  uri: Schema.String,
  sha256: Schema.String,
  mime: Schema.String,
  byteSize: Schema.Int,
  width: Schema.NullOr(Schema.Int),
  height: Schema.NullOr(Schema.Int),
  bytes: Transferable.Uint8Array
}) {}

/** A parsed file: its report, and what goes into the library, if anything. */
export class ParsedFile extends Schema.Class<ParsedFile>("ParsedFile")({
  report: ImportReport,
  /** Of the file's bytes. */
  sha256: Schema.String,
  library: Schema.NullOr(
    Schema.Struct({
      kind: EntityKind,
      label: Schema.String,
      docJson: Schema.String,
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

export class FormatOps extends RpcGroup.make(
  Rpc.make("Parse", {
    payload: { bytes: Transferable.Uint8Array, fileName: Schema.String },
    success: ParsedFile
  }),
  Rpc.make("Export", {
    payload: {
      format: ExportFormat,
      docJson: Schema.String,
      noteDocJson: Schema.NullOr(Schema.String),
      avatar: Schema.NullOr(ExportedFile),
      /** A card's embedded assets, by the URI its assets name them with. */
      assets: Schema.Array(Schema.Struct({ ...ExportedFile.fields, uri: Schema.String }))
    },
    success: Transferable.Uint8Array,
    error: ExportRefused
  })
) {}
