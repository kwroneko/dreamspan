// What an importer tells the user about one imported file (DESIGN §1.2, §1.4): what it
// couldn't represent, what it changed, and what it skipped. Every format parser returns one
// next to its document, so the ST folder importer can merge them into a single report.
import { Schema } from "effect"

export const ImportIssueLevel = Schema.Literals(["info", "warning", "error"])
export type ImportIssueLevel = typeof ImportIssueLevel.Type

export class ImportIssue extends Schema.Class<ImportIssue>("ImportIssue")({
  level: ImportIssueLevel,
  /** A stable machine code, e.g. `preset.unsupported_field`. */
  code: Schema.String,
  /** One plain sentence for the user. */
  message: Schema.String,
  /** Where in the source, as a JSON path, e.g. `["prompts", 3, "content"]`. */
  path: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Number])))
}) {}

export class ImportReport extends Schema.Class<ImportReport>("ImportReport")({
  /** The file's format as detected, e.g. `card-v2-png`, `st-preset`. */
  format: Schema.String,
  issues: Schema.Array(ImportIssue)
}) {}
