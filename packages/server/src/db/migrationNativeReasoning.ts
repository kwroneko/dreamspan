// 0013_native_reasoning (reasoningreplay1, owner 2026-11-23): a plain reply's reasoning as the
// provider sent it (signed blocks, encrypted items, or its text) with what it was written after,
// so a later request can send it back where the preset asks and the provider takes it. Written
// with the reply's final text in the same transaction (FinishGeneration). Not part of
// `version_records`: an edit, a copy or an import makes a version without one.
export const nativeReasoningMigration: ReadonlyArray<string> = [
  `ALTER TABLE version_texts ADD COLUMN native_reasoning TEXT CHECK (native_reasoning IS NULL OR json_valid(native_reasoning))`
]
