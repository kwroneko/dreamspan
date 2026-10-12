// Files in and out of the library (ARCHITECTURE.md §11): what importing a file did, and
// the formats a library document can be exported as.
import { Schema } from "effect"
import { ImportReport } from "./importReport.ts"
import { type EntityKind, LibraryRef, MergeOutcome, RefId } from "./library.ts"

export class ImportedFollower extends Schema.Class<ImportedFollower>("ImportedFollower")({
  refId: RefId,
  label: Schema.String,
  outcome: MergeOutcome
}) {}

/** What a file became in the library. */
export class LibraryImport extends Schema.Class<LibraryImport>("LibraryImport")({
  /** True for a new entity; false for a new import of an existing upstream. */
  created: Schema.Boolean,
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

export const ExportFormat = Schema.Literals([
  "card-v2-json",
  "card-v3-json",
  "card-png",
  "card-charx",
  "st-world-info",
  "st-preset"
])
export type ExportFormat = typeof ExportFormat.Type

/** The formats each kind exports to, the first being the usual one. */
export const exportFormats: Partial<Record<EntityKind, ReadonlyArray<ExportFormat>>> = {
  card: ["card-png", "card-v2-json", "card-v3-json", "card-charx"],
  lorebook: ["st-world-info"],
  preset: ["st-preset"]
}

/** The largest file an import takes (ARCHITECTURE.md §8), so the client can say so before uploading. */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024
