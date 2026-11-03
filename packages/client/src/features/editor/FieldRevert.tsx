// A field-only edit through the same change handler as typing, preserving edit history.
import { getAt, textField, type FieldPath } from "@rp/shared/editing.ts"
import { useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { FieldRevertButton } from "../../ui/FieldRevertButton.tsx"
import { type EditorStore, useRevisionDoc } from "./store.ts"

export function FieldRevert({
  store,
  path,
  field,
  value,
  onChange,
  format = text
}: {
  store: EditorStore
  path: FieldPath
  field?: string
  value: string
  onChange: (value: string) => void
  format?: (value: unknown) => string
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const raw = getAt(useRevisionDoc(store) ?? {}, path)
  const saved = format(raw)
  return (
    <>
      <FieldRevertButton
        changed={value !== saved}
        pending={pending}
        onRevert={() => {
          setPending(true)
          const restored =
            raw === undefined && Array.isArray(getAt(store.working().doc, path))
              ? []
              : typeof raw === "string" || raw === undefined
                ? saved
                : raw
          void store.revertField(field ?? textField(path), path, restored).then((result) => {
            setPending(false)
            setError(result.ok ? null : result.error)
            if (result.ok && format(getAt(store.working().doc, path)) === saved) onChange(saved)
          })
        }}
      />
      <ErrorAlert error={error} />
    </>
  )
}
const text = (value: unknown) => (typeof value === "string" ? value : "")
export const linesText = (value: unknown) => (Array.isArray(value) ? value.join("\n") : "")
