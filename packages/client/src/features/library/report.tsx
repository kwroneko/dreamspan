// An import's report. Its messages quote the file, so they're shown as plain text, never
// as Markdown or HTML (ARCHITECTURE.md §9): React renders strings as text.
import type { ImportIssueLevel } from "@dreamspan/shared/importReport.ts"
import type { MergeOutcome } from "@dreamspan/shared/library.ts"
import type { ImportResult, LibraryImport } from "@dreamspan/shared/libraryImport.ts"
import { Badge } from "../../ui/Surface.tsx"

const OUTCOMES: Record<MergeOutcome, string> = {
  up_to_date: "nothing changed",
  fast_forward: "updated",
  merged: "updated, with its own edits kept",
  conflicts: "its own edits conflict with this version, so it was left as it was until you resolve them"
}

const TONES = { info: "neutral", warning: "warning", error: "danger" } as const satisfies Record<
  ImportIssueLevel,
  string
>

const summary = (library: LibraryImport) =>
  library.created
    ? `Added “${library.ref.label}” to the library as a ${library.ref.kind}.`
    : `Updated “${library.ref.label}”: ${OUTCOMES[library.outcome ?? "up_to_date"]}.`

export function ImportReportView({ result }: { result: ImportResult }) {
  const { report, library } = result
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm">
      <p className="[overflow-wrap:anywhere]">{library ? summary(library) : "Nothing was imported."}</p>
      {library && library.followers.length > 0 && (
        <ul aria-label="Variants updated" className="list-disc pl-5">
          {library.followers.map((follower) => (
            <li key={follower.refId} className="[overflow-wrap:anywhere]">
              {follower.label}: {OUTCOMES[follower.outcome]}
            </li>
          ))}
        </ul>
      )}
      {report.issues.length > 0 && (
        <ul
          aria-label="Import report"
          className="flex max-h-72 flex-col gap-1.5 overflow-y-auto rounded-md border border-border bg-canvas p-2"
        >
          {report.issues.map((issue, index) => (
            <li key={index} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <Badge tone={TONES[issue.level]}>{issue.level}</Badge>
              <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{issue.message}</span>
              {issue.path && (
                <span className="min-w-0 font-mono text-xs text-muted [overflow-wrap:anywhere]">
                  {issue.path.join(".")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">Read as {report.format}</p>
    </div>
  )
}
