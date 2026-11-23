// Explicit preview before applying only the selected part of a shared ST preset.
import type { StSettingsImport } from "@dreamspan/shared/modelSettings.ts"
import { useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { formatByteSize } from "@dreamspan/shared/byteSize.ts"
import { Field, Input } from "../../ui/Field.tsx"
import { Alert } from "../../ui/Surface.tsx"

/** The settings an import would apply, one row each: "Temperature", "0.7". */
const NAMES: Readonly<Record<string, string>> = {
  "samplers.temperature": "Temperature",
  "samplers.top_p": "Top P",
  "samplers.top_k": "Top K",
  "samplers.min_p": "Min P",
  "samplers.top_a": "Top A",
  "samplers.frequency_penalty": "Frequency penalty",
  "samplers.presence_penalty": "Presence penalty",
  "samplers.repetition_penalty": "Repetition penalty",
  "samplers.seed": "Seed",
  "samplers.openai_max_context": "Context",
  "samplers.openai_max_tokens": "Reply length",
  "samplers.reasoning_effort": "Reasoning effort",
  "samplers.verbosity": "Verbosity",
  context_target: "Trim history to",
  names_behavior: "Speaker names",
  squash: "Squash system messages",
  postprocess: "Prompt post-processing",
  use_sysprompt: "System prompt as the system parameter",
  stop: "Stop strings",
  logit_bias: "Token biases",
  stream: "Show the reply as it’s written",
  cacheRetention: "Prompt cache lifetime",
  routing: "Routing",
  kind: "API type",
  baseUrl: "Address",
  model: "Model"
}

const shown = (value: unknown): string =>
  Array.isArray(value)
    ? value.map(shown).join(", ")
    : typeof value === "object" && value !== null
      ? Object.entries(value)
          .map(([key, inner]) => `${key}: ${shown(inner)}`)
          .join("; ")
      : value === null
        ? "none"
        : String(value)

const entriesOf = (settings: Readonly<Record<string, unknown>> | null): ReadonlyArray<readonly [string, string]> =>
  Object.entries(settings ?? {}).flatMap(([key, value]) =>
    key === "samplers" && typeof value === "object" && value !== null
      ? Object.entries(value).map(([inner, v]) => [NAMES[`samplers.${inner}`] ?? inner, shown(v)] as const)
      : [[NAMES[key] ?? key, shown(value)] as const]
  )

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
        label={`Import ${surface} settings from an ST preset`}
        about={`Choose an ST preset file (.json). Only its ${surface} settings are applied; review them before importing.`}
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
          <dl
            className="grid max-h-48 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 overflow-auto rounded-md bg-surface-raised p-3 text-sm"
            aria-label="Settings to import"
          >
            {entriesOf(surface === "model" ? preview.model : preview.connection).map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="text-muted">{name}</dt>
                <dd className="text-text [overflow-wrap:anywhere]">{value}</dd>
              </div>
            ))}
          </dl>
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
