// "Change for selected…" (owner, 2026-11-01): one setting, its new value, applied to the
// selected entries; only that setting changes. Applied as a revision of its own, which the
// toast's Undo and History take back (lorebookMass.ts).
import type { LorebookEntry } from "@rp/shared/docs/lorebook.ts"
import type { FieldPath } from "@rp/shared/editing.ts"
import { useState, useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { NativeSelect } from "../../ui/Select.tsx"
import {
  applyMassChange,
  type LorebookMassSetting,
  lorebookMassSettings,
  type MassValue,
  patchEdits,
  touched
} from "./lorebookMass.ts"
import { entryPath } from "./lorebookTable.ts"
import type { EditorStore } from "./store.ts"

const useSettings = () => {
  const snapshot = useSyncExternalStore(
    lorebookMassSettings.subscribe,
    lorebookMassSettings.snapshot,
    lorebookMassSettings.snapshot
  )
  return [...snapshot.entries].sort((a, b) => a.order - b.order)
}

/** A value as the revision's message says it. */
const valueLabel = (setting: LorebookMassSetting, value: MassValue) => {
  const input = setting.input
  if (input.kind === "choice") return input.options.find((option) => option.value === value)?.label ?? String(value)
  if (input.kind === "switch") return value === true ? input.on.toLowerCase() : input.off.toLowerCase()
  if (value === null || value === "") return "empty"
  return input.kind === "text" ? `“${String(value)}”` : String(value)
}

function ValueInput({
  setting,
  value,
  onChange
}: {
  setting: LorebookMassSetting
  value: MassValue
  onChange: (value: MassValue) => void
}) {
  const input = setting.input
  const [typed, setTyped] = useState(value === null ? "" : String(value))
  if (input.kind === "choice")
    return (
      <Field label="New value">
        <NativeSelect
          ariaLabel="New value"
          items={input.options}
          value={String(value)}
          onValueChange={(next) => onChange(next)}
        />
      </Field>
    )
  if (input.kind === "switch")
    return (
      <Segmented
        label="New value"
        value={value === true ? "on" : "off"}
        onValueChange={(next) => onChange(next === "on")}
        options={[
          { value: "on", label: input.on },
          { value: "off", label: input.off }
        ]}
      />
    )
  if (input.kind === "text")
    return (
      <Field label="New value">
        <Input value={String(value ?? "")} onChange={(event) => onChange(event.currentTarget.value)} />
      </Field>
    )
  return (
    <Field
      label="New value"
      description={[
        input.min !== undefined && input.max !== undefined ? `From ${input.min} to ${input.max}.` : "",
        input.nullable ? "Empty: not set, so the default applies." : ""
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Input
        type="number"
        inputMode="numeric"
        min={input.min}
        max={input.max}
        step={input.integer ? 1 : "any"}
        value={typed}
        onChange={(event) => {
          const text = event.currentTarget.value
          setTyped(text)
          const number = Number(text)
          if (text.trim() === "") {
            if (input.nullable) onChange(null)
          } else if (
            Number.isFinite(number) &&
            (!input.integer || Number.isInteger(number)) &&
            (input.min === undefined || number >= input.min) &&
            (input.max === undefined || number <= input.max)
          )
            onChange(number)
        }}
      />
    </Field>
  )
}

export function MassEditDialog({
  store,
  root,
  uids,
  onClose
}: {
  store: EditorStore
  root: FieldPath
  uids: ReadonlyArray<number>
  onClose: () => void
}) {
  const settings = useSettings()
  const entries = uids.flatMap((uid) => {
    const entry = store.value(entryPath(root, uid)) as LorebookEntry | undefined
    return entry ? [entry] : []
  })
  const [id, setId] = useState(settings[0]?.id ?? "")
  const setting = settings.find((s) => s.id === id) ?? settings[0]
  const [values, setValues] = useState<Readonly<Record<string, MassValue>>>({})
  if (!setting || entries.length === 0) return null
  const value = id in values ? values[id]! : setting.current(entries[0]!)
  const edits = patchEdits(root, entries, setting.patch(value))
  const count = touched(edits)
  const apply = () => {
    applyMassChange(
      store,
      `Set ${setting.label} to ${valueLabel(setting, value)} on ${count} ${count === 1 ? "entry" : "entries"}`,
      edits
    )
    onClose()
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Change for ${entries.length} selected ${entries.length === 1 ? "entry" : "entries"}`}
      description="Sets one setting on every selected entry; their other settings stay as they are. It's an unsaved change like any edit: Save keeps it, Revert undoes it."
    >
      <Field label="Setting" description={setting.description}>
        <NativeSelect
          ariaLabel="Setting"
          items={settings.map((s) => ({ value: s.id, label: s.label, description: s.description }))}
          value={setting.id}
          onValueChange={setId}
        />
      </Field>
      <ValueInput
        key={setting.id}
        setting={setting}
        value={value}
        onChange={(next) => setValues((all) => ({ ...all, [setting.id]: next }))}
      />
      <p role="status" className="text-sm text-muted">
        {count === 0
          ? "Every selected entry already has this."
          : count === entries.length
            ? `Changes all ${count} selected.`
            : `Changes ${count} of the ${entries.length} selected; the others already have it.`}
      </p>
      <DialogActions>
        <Button variant="ghost" hint="Closes this without changing any entry." onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={count === 0}
          hint="Sets it on these entries as an unsaved change: Save keeps it, Revert undoes it."
          onClick={apply}
        >
          Apply to {count} {count === 1 ? "entry" : "entries"}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
