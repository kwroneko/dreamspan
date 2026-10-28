import { CardSurface } from "../cardForks/surfaces.tsx"
import { PresetWorkspace, PresetOverlayHost, usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
// The library: cards, lorebooks and presets by label, each exportable as a file.
import type { LibraryRef } from "@rp/shared/library.ts"
import { type ExportFormat, type ExportFormatInfo } from "@rp/shared/libraryImport.ts"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { AsyncView, useAction } from "../../actions.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Checkbox } from "../../ui/Choice.tsx"
import { Field } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { NewCardButton } from "../editor/NewCard.tsx"
import { useTitle } from "../shell.tsx"
import { LISTED, libraryAtom } from "./data.ts"
import { downloadExport } from "./files.ts"

/** In the persona folder or not (DESIGN §2.2): personas are what the user plays. */
function PersonaToggle({ entry, persona }: { entry: LibraryRef; persona: boolean }) {
  const action = useAction()
  return (
    <>
      <Checkbox
        checked={persona}
        onCheckedChange={(next) =>
          void action.run((client) => client("SetPersona", { entityId: entry.entityId, persona: next }), ["library"])
        }
      >
        <span className="sr-only">{entry.label}: </span>Persona
      </Checkbox>
      {action.error && (
        <p role="alert" className="text-sm text-danger">
          {action.error.message}
        </p>
      )}
    </>
  )
}

function LibraryRow({
  entry,
  persona,
  exporters
}: {
  entry: LibraryRef
  persona?: boolean | undefined
  exporters: ReadonlyArray<ExportFormatInfo>
}) {
  const workspace = usePresetWorkspace()
  const formats = exporters.filter((format) => format.kind === entry.kind)
  const [selectedFormat, setFormat] = useState<ExportFormat | null>(null)
  const format = formats.find((entry) => entry.id === selectedFormat)?.id ?? formats[0]?.id ?? null
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
          {entry.kind === "card" && <CardSurface placement="badge" entityId={entry.entityId} />}
          {entry.kind !== "card" && entry.refKind === "variant" && <Badge>variant</Badge>}
          {entry.updateAvailable && <Badge tone="warning">update available</Badge>}
        </div>
        {entry.kind === "card" && <CardSurface placement="provenance" entityId={entry.entityId} />}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {entry.kind === "card" && <CardSurface placement="actions" entityId={entry.entityId} />}
        {persona !== undefined && <PersonaToggle entry={entry} persona={persona} />}
        {entry.kind === "card" && (
          <Link
            to="/cards/$entityId/chat"
            params={{ entityId: entry.entityId }}
            aria-label={`Start a chat with ${entry.label}`}
            className={buttonClass("primary")}
          >
            Chat
          </Link>
        )}
        {entry.kind === "preset" ? (
          <Button aria-label={`Edit ${entry.label}`} onClick={() => workspace?.open(entry.id)}>
            Edit
          </Button>
        ) : (
          entry.kind !== "lorebook" && (
            <Link
              to="/library/$refId"
              params={{ refId: entry.id }}
              aria-label={`Edit ${entry.label}`}
              className={buttonClass("secondary")}
            >
              Edit
            </Link>
          )
        )}
        {entry.refKind === "upstream" && (entry.kind !== "card" || entry.hasImport) && (
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
              items={formats.map(({ id, label }) => ({ value: id, label }))}
              value={format}
              onValueChange={setFormat}
            />
          </Field>
        )}
        <Button
          disabled={format === null}
          pending={pending}
          onClick={() => void exportEntry()}
          aria-label={`Export ${entry.label}`}
        >
          Export
        </Button>
      </div>
    </li>
  )
}

function LibraryContent() {
  useTitle("Library")
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Library</h1>
        <div className="flex flex-wrap gap-2">
          <NewCardButton />
          <Link to="/import" className={buttonClass("primary")}>
            Import files
          </Link>
        </div>
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
                    <LibraryRow
                      key={entry.id}
                      entry={entry}
                      exporters={lists.exportFormats}
                      persona={
                        kind === "card"
                          ? lists.castCards.some((card) => card.entityId === entry.entityId && card.persona)
                          : undefined
                      }
                    />
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

export function LibraryPage() {
  return (
    <PresetWorkspace>
      <LibraryContent />
      <PresetOverlayHost page />
    </PresetWorkspace>
  )
}
