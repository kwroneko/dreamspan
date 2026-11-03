// Explicit preview before applying only the selected part of a shared ST preset.
import type { StSettingsImport } from "@rp/shared/modelSettings.ts"
import { useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { formatByteSize } from "@rp/shared/byteSize.ts"
import { Field, Input } from "../../ui/Field.tsx"
import { Alert } from "../../ui/Surface.tsx"

export function StSettingsImporter({
  surface,
  apply
}: {
  surface: "model" | "connection"
  apply: (preview: StSettingsImport) => Promise<void>
}) {
  const action = useAction()
  const [preview, setPreview] = useState<StSettingsImport | null>(null)
  const [applied, setApplied] = useState(false)
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-3">
      <Field
        label={`Import ${surface} settings from an ST preset JSON`}
        about="Only this part is applied. Review the report before importing."
      >
        <Input
          type="file"
          accept=".json,application/json"
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0]
            setPreview(null)
            setApplied(false)
            setProblem(null)
            if (!file) return
            if (file.size > 2_000_000) {
              setProblem(`Choose a JSON file no larger than ${formatByteSize(2_000_000)}.`)
              return
            }
            try {
              const text = await file.text()
              const result = await action.run((client) => client("PreviewStSettings", { text, surface }))
              if (result.ok) setPreview(result.value)
            } catch {
              setProblem("The file couldn't be read.")
            }
          }}
        />
      </Field>
      {problem && (
        <Alert tone="danger" title="Not imported">
          {problem}
        </Alert>
      )}
      <ErrorAlert error={action.error} />
      {applied && surface === "model" && (
        <p role="status" className="text-sm text-muted">
          Loaded into the form. Save model settings to apply.
        </p>
      )}
      {preview && (
        <>
          <pre
            className="max-h-48 overflow-auto rounded-md bg-surface-raised p-3 text-xs text-text"
            aria-label="Settings to import"
          >
            {JSON.stringify(surface === "model" ? preview.model : preview.connection, null, 2)}
          </pre>
          <ul className="max-h-48 overflow-auto text-sm text-muted" aria-label="Import report">
            {preview.report.issues.map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
          <Button
            pending={pending}
            hint={
              surface === "model"
                ? "Fills the form with these settings. Nothing is saved until you save the model’s settings."
                : "Makes a new connection with these settings, and adds the model it names."
            }
            disabled={
              pending ||
              preview.report.issues.some((issue) => issue.level === "error") ||
              !(surface === "model" ? preview.model : preview.connection)
            }
            onClick={async () => {
              setPending(true)
              try {
                await apply(preview)
                setApplied(true)
              } finally {
                setPending(false)
              }
            }}
          >
            Import {surface} settings
          </Button>
        </>
      )}
    </div>
  )
}
