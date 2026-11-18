// 0005_preview_macro (rowmacro1): a template preview (a greeting) keeps the ids its {{user}} and
// {{char}} follow, so a list row shows it with its macros replaced (db/previewText.ts). Existing
// summaries are format 10 and the format moves to 11, so each is recomputed when next read;
// nothing is backfilled.
export const previewMacroMigration: ReadonlyArray<string> = [
  `ALTER TABLE fork_summaries ADD COLUMN preview_macro TEXT CHECK (preview_macro IS NULL OR json_valid(preview_macro))`
]
