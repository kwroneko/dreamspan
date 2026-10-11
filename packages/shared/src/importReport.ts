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

/** How much of a file a report can hold, so a hostile file can't make it large. */
const MAX_ISSUES = 200
const MAX_SHOWN_CHARS = 40
const MAX_SHOWN_ITEMS = 10
const MAX_PATH_SEGMENTS = 16

type Path = ReadonlyArray<string | number>

/** File-supplied text as a report shows it: at most 40 characters. */
export const shownText = (text: string) => (text.length > MAX_SHOWN_CHARS ? `${text.slice(0, MAX_SHOWN_CHARS)}…` : text)

/** File-supplied names as a report lists them: the first 10, each shortened, then a count. */
export const shownList = (items: ReadonlyArray<string>) =>
  items.slice(0, MAX_SHOWN_ITEMS).map(shownText).join(", ") +
  (items.length > MAX_SHOWN_ITEMS ? ` and ${items.length - MAX_SHOWN_ITEMS} more` : "")

const shownPath = (path: Path) =>
  (path.length > MAX_PATH_SEGMENTS ? [...path.slice(0, MAX_PATH_SEGMENTS - 1), "…"] : path).map((segment) =>
    typeof segment === "string" ? shownText(segment) : segment
  )

/**
 * Collects a file's issues with the report's size bounded: 200 issues at most, then one
 * `report.truncated` issue with the count left out. Paths are shortened here; messages
 * that quote the file should quote it through `shownText`.
 */
export class ReportBuilder {
  private readonly issues: Array<ImportIssue> = []
  private dropped = 0

  add(level: ImportIssueLevel, code: string, message: string, path?: Path) {
    if (this.issues.length >= MAX_ISSUES) this.dropped++
    else this.issues.push(new ImportIssue({ level, code, message, ...(path ? { path: shownPath(path) } : {}) }))
  }

  build(format: string) {
    const truncated = new ImportIssue({
      level: "info",
      code: "report.truncated",
      message: `${this.dropped} more issues aren't listed.`
    })
    return new ImportReport({ format, issues: this.dropped > 0 ? [...this.issues, truncated] : this.issues })
  }
}
