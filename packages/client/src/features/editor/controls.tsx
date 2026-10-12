// Form controls bound to an editor's fields: each reads its own field from the store and
// writes it as a draft, so every change is on the server within a second, with its history.
import type { DraftState } from "@rp/shared/drafts.ts"
import { type FieldPath, textField, valueField } from "@rp/shared/editing.ts"
import { type ReactNode, useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Checkbox, Switch } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input, Textarea } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Badge } from "../../ui/Surface.tsx"
import type { CallResult } from "./caller.ts"
import { type EditorStore, useDirty, useText, useValue } from "./store.ts"

/** "Edited" while the field has changes, with its undo, history and revert. */
function FieldLabel({ store, field, label }: { store: EditorStore; field: string; label: string }) {
  const dirty = useDirty(store, field)
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <span>{label}</span>
      {dirty && <Badge tone="accent">edited</Badge>}
    </span>
  )
}

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" })

/** A field's undo history: every state it had in this drafting session, restorable. */
function HistoryDialog({
  store,
  field,
  label,
  onClose
}: {
  store: EditorStore
  field: string
  label: string
  onClose: () => void
}) {
  const [states, setStates] = useState<ReadonlyArray<DraftState> | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  useEffect(() => {
    void store.history(field).then((result) => (result.ok ? setStates(result.value) : setError(result.error)))
  }, [store, field])
  const restore = async (seq: number) => {
    const result = await store.restore(field, seq)
    if (result.ok) onClose()
    else setError(result.error)
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={`History of ${label}`}>
      <ErrorAlert error={error} />
      {states === null && error === null && <p className="text-sm text-muted">Loading…</p>}
      {states !== null && (
        <ol aria-label="Earlier states" className="flex flex-col divide-y divide-border">
          {states.map((state, index) => (
            <li key={state.seq} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-col text-sm">
                <span className="font-medium">
                  {index === 0 ? "Now" : state.kind === "initial" ? "As saved" : when(state.at)} · {state.length}{" "}
                  characters
                </span>
                {state.kind !== "initial" && (
                  <span className="text-muted [overflow-wrap:anywhere]">
                    {state.kind === "restore" ? "Restored. " : ""}
                    {state.removed && <del>{state.removed}</del>} {state.inserted && <ins>{state.inserted}</ins>}
                  </span>
                )}
              </div>
              {index > 0 && (
                <Button variant="ghost" onClick={() => void restore(state.seq)}>
                  Restore
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}

/** Undo, history and revert for a field with changes. */
export function FieldTools({ store, field, label }: { store: EditorStore; field: string; label: string }) {
  const dirty = useDirty(store, field)
  const [history, setHistory] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  if (!dirty) return null
  const settle = (result: CallResult<unknown> | undefined) => setError(result && !result.ok ? result.error : null)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        <Button variant="ghost" aria-label={`Undo ${label}`} onClick={() => void store.undo(field).then(settle)}>
          Undo
        </Button>
        <Button variant="ghost" aria-label={`History of ${label}`} onClick={() => setHistory(true)}>
          History
        </Button>
        <Button variant="ghost" aria-label={`Revert ${label}`} onClick={() => void store.discard(field).then(settle)}>
          Revert
        </Button>
      </div>
      <ErrorAlert error={error} />
      {history && <HistoryDialog store={store} field={field} label={label} onClose={() => setHistory(false)} />}
    </div>
  )
}

/** A text field. Long ones are textareas; `mono` for patterns. */
export function TextField({
  store,
  path,
  label,
  rows,
  description,
  mono = false,
  readOnly = false
}: {
  store: EditorStore
  path: FieldPath
  label: string
  rows?: number
  description?: ReactNode
  mono?: boolean
  readOnly?: boolean
}) {
  const value = useText(store, path)
  const field = textField(path)
  const props = {
    value,
    readOnly,
    spellCheck: !mono,
    className: mono ? "font-mono" : "",
    onBlur: () => void store.save(field)
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Field label={<FieldLabel store={store} field={field} label={label} />} description={description}>
        {rows === undefined ? (
          <Input {...props} onChange={(event) => store.setText(path, event.currentTarget.value)} />
        ) : (
          <Textarea
            {...props}
            rows={rows}
            className={`resize-y ${props.className}`}
            onChange={(event) => store.setText(path, event.currentTarget.value)}
          />
        )}
      </Field>
      <FieldTools store={store} field={field} label={label} />
    </div>
  )
}

/** A number, kept as typed until it's a number, so "0." can become "0.5". */
export function NumberField({
  store,
  path,
  label,
  step = "any",
  min,
  max,
  integer = false,
  nullable = false
}: {
  store: EditorStore
  path: FieldPath
  label: string
  step?: string
  min?: number
  max?: number
  integer?: boolean
  /** Empty means no value (null). */
  nullable?: boolean
}) {
  const value = useValue<number | null>(store, path)
  const [typed, setTyped] = useState<string | null>(null)
  const field = valueField(path)
  const accept = (text: string) => {
    setTyped(text)
    if (nullable && text.trim() === "") {
      if (value !== null) store.setValue(path, null)
      return
    }
    const number = Number(text)
    const valid =
      text.trim() !== "" &&
      Number.isFinite(number) &&
      (!integer || Number.isInteger(number)) &&
      (min === undefined || number >= min) &&
      (max === undefined || number <= max)
    if (valid && number !== value) store.setValue(path, number)
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Field label={<FieldLabel store={store} field={field} label={label} />}>
        <Input
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          max={max}
          value={typed ?? (typeof value === "number" ? String(value) : "")}
          onChange={(event) => accept(event.currentTarget.value)}
          onBlur={() => {
            setTyped(null)
            void store.save(field)
          }}
        />
      </Field>
      <FieldTools store={store} field={field} label={label} />
    </div>
  )
}

export function SwitchField({
  store,
  path,
  label,
  description,
  checkbox = false
}: {
  store: EditorStore
  path: FieldPath
  label: string
  description?: ReactNode
  checkbox?: boolean
}) {
  const value = useValue<boolean | undefined>(store, path) === true
  const Control = checkbox ? Checkbox : Switch
  return (
    <Control checked={value} onCheckedChange={(checked) => store.setValue(path, checked)} description={description}>
      {label}
    </Control>
  )
}

/** One of a few values. `text` when the field is a string the user could also type. */
export function SelectField<Value extends string>({
  store,
  path,
  label,
  items
}: {
  store: EditorStore
  path: FieldPath
  label: string
  items: ReadonlyArray<{ readonly value: Value; readonly label: string }>
}) {
  const value = useValue<Value>(store, path)
  const field = valueField(path)
  return (
    <Field label={<FieldLabel store={store} field={field} label={label} />}>
      <Select items={items} value={value ?? null} onValueChange={(next) => store.setValue(path, next)} />
    </Field>
  )
}
