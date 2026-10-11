// Files in and out of the library (ARCHITECTURE.md §10): what importing a file did.
import { Schema } from "effect"
import { LibraryRef, MergeOutcome, RefId } from "./library.ts"

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
  note: Schema.NullOr(LibraryRef)
}) {}
