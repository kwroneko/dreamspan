// The library: cards, lorebooks and presets by label, each exportable as a file.
import type { LibraryRef } from "@rp/shared/library.ts"
import { type ExportFormat, exportFormats } from "@rp/shared/libraryImport.ts"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { AsyncView } from "../../actions.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Field } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"
import { FORMAT_LABELS, LISTED, libraryAtom } from "./data.ts"
import { downloadExport } from "./files.ts"

function LibraryRow({ entry }: { entry: LibraryRef }) {
  const formats = exportFormats[entry.kind] ?? []
  const [format, setFormat] = useState<ExportFormat | null>(formats[0] ?? null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const exportEntry = async () => {
    if (format === null) return
    setPending(true)
    setError(await downloadExport(entry.id, format, entry.label))
    setPending(false)
  }

  return (
    <li className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{entry.label}</span>
          {entry.subtitle && (
            <span className="min-w-0 text-sm text-muted [overflow-wrap:anywhere]">{entry.subtitle}</span>
          )}
          {entry.refKind === "variant" && <Badge>variant</Badge>}
          {entry.updateAvailable && <Badge tone="warning">update available</Badge>}
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {entry.refKind === "upstream" && (
          <Link
            to="/import"
            search={{ into: entry.id }}
            aria-label={`Update ${entry.label} from a file`}
            className={buttonClass("ghost")}
          >
            Update from file
          </Link>
        )}
        {formats.length > 1 && (
          <Field label={<span className="sr-only">Export format for {entry.label}</span>} className="w-28">
            <Select
              items={formats.map((value) => ({ value, label: FORMAT_LABELS[value] }))}
              value={format}
              onValueChange={setFormat}
            />
          </Field>
        )}
        <Button pending={pending} onClick={() => void exportEntry()} aria-label={`Export ${entry.label}`}>
          Export
        </Button>
      </div>
    </li>
  )
}

export function LibraryPage() {
  useTitle("Library")
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Library</h1>
        <Link to="/import" className={buttonClass("primary")}>
          Import files
        </Link>
      </header>
      <AsyncView atom={libraryAtom} loading="Loading the library…">
        {(lists) =>
          LISTED.map(({ kind, title }) => (
            <Card key={kind}>
              <CardHeader title={title} />
              {lists[kind].length === 0 ? (
                <EmptyState title={`No ${title.toLowerCase()} yet`}>
                  <p>Import files to add some.</p>
                </EmptyState>
              ) : (
                <ul aria-label={title} className="flex flex-col divide-y divide-border">
                  {lists[kind].map((entry) => (
                    <LibraryRow key={entry.id} entry={entry} />
                  ))}
                </ul>
              )}
            </Card>
          ))
        }
      </AsyncView>
    </div>
  )
}
