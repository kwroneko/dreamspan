// The format workers' operations (ARCHITECTURE.md §10.2): parsing an uploaded file and
// writing an export, both CPU work on untrusted or large data, kept off the main thread.
import { ImportReport } from "@rp/shared/importReport.ts"
import { EntityKind } from "@rp/shared/library.ts"
import { Schema } from "effect"
import { Transferable } from "effect/workers"

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
