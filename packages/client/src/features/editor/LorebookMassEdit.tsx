// "Edit N entries" (owner, 2026-11-02): the entry settings form (lorebookSettings.ts) for the
// selected entries at once. Each setting has a checkbox: unticked, it's left alone, shown
// greyed with the value the entries share or "Mixed"; ticked, its value goes on every selected
// entry, and an empty text or number clears it. Several settings apply at once, as unsaved
// changes like any edit (lorebookMass.ts).
import { useDurableForm } from "./durable.tsx"
import type { LorebookEntry } from "@dreamspan/shared/docs/lorebook.ts"
import type { FieldPath } from "@dreamspan/shared/editing.ts"
import { Button } from "../../ui/Button.tsx"
import { Checkbox, Switch } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { SettingsLayout, useFormSections } from "./LorebookEntryDetails.tsx"
import { applyMassChange, patchEdits, touched } from "./lorebookMass.ts"
import { type Common, commonValue, type LorebookEntrySetting, manyPatch, type MassValue } from "./lorebookSettings.ts"
import { entryPath } from "./lorebookTable.ts"
import type { EditorStore } from "./store.ts"

const entriesLabel = (count: number) => `${count.toLocaleString()} ${count === 1 ? "entry" : "entries"}`

/** The quiet marker beside a setting whose entries differ; its hover says how. */
function MixedMarker({ breakdown }: { breakdown: string }) {
  return (
    <Tooltip label={breakdown}>
      <span
        data-mixed
        tabIndex={0}
        aria-label={`Mixed: ${breakdown}`}
        className="inline-flex h-4 shrink-0 items-center rounded-sm border border-dashed border-border px-1 text-[10px] leading-none text-muted outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        ≠
      </span>
    </Tooltip>
  )
}

/** A setting's control for many entries, beside the checkbox that says whether it changes. */
function ManySetting({
  setting,
  common,
  ticked,
  value,
  onTick,
  onChange
}: {
  setting: LorebookEntrySetting
  common: Common
  ticked: boolean
  value: MassValue | undefined
  onTick: (ticked: boolean) => void
  onChange: (value: MassValue) => void
}) {
  const input = setting.input
  const mixed = !ticked && common.mixed
  // Unticked it shows what the entries have; ticked, what will be set (nothing chosen yet: empty).
  const shown = ticked ? value : common.mixed ? undefined : common.value
  const marker = common.mixed && <MixedMarker breakdown={common.breakdown} />
  const label = setting.label
  const control = (() => {
    switch (input.kind) {
      case "switch":
        return (
          <Switch
            checked={shown === true}
            mixed={mixed || (ticked && shown === undefined)}
            disabled={!ticked}
            onCheckedChange={onChange}
            about={setting.description}
            aboutLabel={setting.label}
          >
            {label}
          </Switch>
        )
      case "choice":
      case "inherit": {
        const items =
          input.kind === "choice"
            ? input.options
            : [
                { value: "inherit", label: `Default (${input.fallback})`, description: "Not set on the entry." },
                { value: "true", label: "On" },
                { value: "false", label: "Off" }
              ]
        return (
          <Field label={label} about={setting.description} aboutLabel={setting.label}>
            <Select
              ariaLabel={setting.label}
              items={items}
              value={shown === undefined || shown === null ? null : String(shown)}
              disabled={!ticked}
              mixed={common.mixed && shown === undefined}
              placeholder={common.mixed ? "Mixed" : "Choose"}
              onValueChange={onChange}
            />
          </Field>
        )
      }
      case "number":
      case "text":
        return (
          <Field label={label} about={setting.description} aboutLabel={setting.label}>
            <Input
              aria-label={setting.label}
              {...(input.kind === "number"
                ? {
                    type: "number",
                    inputMode: "numeric" as const,
                    min: input.min,
                    max: input.max,
                    step: input.integer ? 1 : "any"
                  }
                : {})}
              disabled={!ticked}
              placeholder={common.mixed && !ticked ? "Mixed" : ticked ? "Empty: clears it" : ""}
              className="placeholder:italic"
              value={shown === undefined || shown === null ? "" : String(shown)}
              onChange={(event) => {
                const text = event.currentTarget.value
                if (input.kind === "text") return onChange(text)
                onChange(text.trim() === "" ? "" : Number(text))
              }}
            />
          </Field>
        )
    }
  })()
  return (
    <div className="flex min-w-0 items-start gap-2" data-setting={setting.id}>
      <Tooltip
        label={ticked ? "Leaves this setting as each entry has it." : "Changes this setting on every selected entry."}
      >
        <span className="mt-0.5 inline-flex shrink-0">
          <Checkbox labelHidden checked={ticked} onCheckedChange={onTick}>
            {`Change ${setting.label}`}
          </Checkbox>
        </span>
      </Tooltip>
      <div className={`min-w-0 flex-1 ${ticked ? "" : "opacity-60"}`}>{control}</div>
      {marker && <span className="mt-1 shrink-0">{marker}</span>}
    </div>
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
  const card = root.length > 0
  const sections = useFormSections({ card, many: true })
  const entries = uids.flatMap((uid) => {
    const entry = store.value(entryPath(root, uid)) as LorebookEntry | undefined
    return entry ? [entry] : []
  })
  // The ticked settings and their values (undefined: nothing chosen yet).
  // Kept as typed: each ticked setting as { v } (absent v: nothing chosen yet), since JSON has no undefined.
  const form = useDurableForm<{ ticked: Readonly<Record<string, { v?: MassValue }>> }>(
    `mass-edit:${store.refId}:${root.join("/")}`,
    "Mass edit",
    { ticked: {} }
  )
  const ticked: Readonly<Record<string, MassValue | undefined>> = Object.fromEntries(
    Object.entries(form.values.ticked).map(([id, kept]) => [id, kept.v])
  )
  const setTicked = (
    change: (all: Readonly<Record<string, MassValue | undefined>>) => Readonly<Record<string, MassValue | undefined>>
  ) =>
    form.edit({
      ticked: Object.fromEntries(Object.entries(change(ticked)).map(([id, v]) => [id, v === undefined ? {} : { v }]))
    })
  const close = () => {
    void form.discard()
    onClose()
  }
  if (entries.length === 0) return null
  const settings = sections.flatMap((item) => item.settings)
  const edits = patchEdits(root, entries, manyPatch(settings, ticked))
  const count = touched(edits)
  const changedNames = settings.filter((setting) => setting.id in ticked).map((setting) => setting.label)
  const apply = () => {
    applyMassChange(store, `Changed ${changedNames.join(", ")} on ${entriesLabel(count)}`, edits)
    void form.commit(async () => true)
    onClose()
  }
  return (
    <Dialog open size="wide" onOpenChange={(open) => !open && close()} title={`Edit ${entriesLabel(entries.length)}`}>
      <SettingsLayout
        sections={sections}
        accordion={false}
        wide={false}
        flow
        label={`${entriesLabel(entries.length)}`}
        render={(setting) => {
          const common = commonValue(setting, entries)
          return (
            <ManySetting
              setting={setting}
              common={common}
              ticked={setting.id in ticked}
              value={ticked[setting.id]}
              onTick={(next) =>
                setTicked((all) => {
                  const copy = { ...all }
                  // A mixed text or number starts empty, which clears it; a mixed choice, unchosen.
                  const typed = setting.input.kind === "text" || setting.input.kind === "number"
                  if (next) copy[setting.id] = common.mixed ? (typed ? "" : undefined) : common.value
                  else delete copy[setting.id]
                  return copy
                })
              }
              onChange={(value) => setTicked((all) => ({ ...all, [setting.id]: value }))}
            />
          )
        }}
      />
      <DialogActions>
        <Button variant="ghost" hint="Closes this without changing any entry." onClick={close}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={count === 0}
          hint="Sets the ticked settings on the selected entries that don't have them yet."
          onClick={apply}
        >
          Apply to {entriesLabel(count)}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
