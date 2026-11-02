// Files in and out of the library (ARCHITECTURE.md §11): what importing a file did, and
// the formats a library document can be exported as.
import { Schema } from "effect"
import { ImportReport } from "./importReport.ts"
import { EntityKind, LibraryRef, MergeOutcome, RefId, RevisionId } from "./library.ts"

export class ImportedFollower extends Schema.Class<ImportedFollower>("ImportedFollower")({
  refId: RefId,
  label: Schema.String,
  outcome: MergeOutcome
}) {}

/** What a file became in the library. */
export class LibraryImport extends Schema.Class<LibraryImport>("LibraryImport")({
  /** True for a new entity; false for a new import of an existing upstream. */
  created: Schema.Boolean,
  /** A file staged for explicit merge; the ref head and card-owned notes are unchanged. */
  stagedRevisionId: Schema.optionalKey(RevisionId),
  /** The upstream ref, after the import. */
  ref: LibraryRef,
  /** On a re-import: how the upstream merged the new file with its own edits. */
  outcome: Schema.NullOr(MergeOutcome),
  /** On a re-import: what happened to every ref following the upstream, transitively. */
  followers: Schema.Array(ImportedFollower),
  /** The card's note made from ST's Character's Note, if the card has one. */
  note: Schema.NullOr(LibraryRef),
  /** On a re-import of a card from a file without an avatar: the card kept its current one. */
  keptAvatar: Schema.Boolean,
  /** On a re-import of a card: how many embedded files it kept that the new file doesn't hold. */
  keptAssets: Schema.Int
}) {}

/** The answer to one uploaded file. */
export class ImportResult extends Schema.Class<ImportResult>("ImportResult")({
  report: ImportReport,
  /** Null when nothing was imported; the report says why. */
  library: Schema.NullOr(LibraryImport)
}) {}

/** Format ids are open; the worker's exporter registry validates them at use. */
export const ExportFormat = Schema.String
export type ExportFormat = typeof ExportFormat.Type

/** Data only: executable exporters stay inside format workers. List order is preference order. */
export const ExportFormatInfo = Schema.Struct({
  id: ExportFormat,
  kind: EntityKind,
  label: Schema.String,
  mime: Schema.String,
  extension: Schema.String,
  media: Schema.Literals(["none", "avatar", "all"]),
  /** What the file holds, in a sentence, shown beside the format's menu entry. */
  description: Schema.optionalKey(Schema.String)
})
export type ExportFormatInfo = typeof ExportFormatInfo.Type

/** The largest file an import takes (ARCHITECTURE.md §8), so the client can say so before uploading. */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024
