import { ChatLock } from "./PickerParts.tsx"
// The model picker: the composer's model chip and the Model tab open this same list. A filter,
// Name or Used, when each model last wrote a reply under its name, and Manage connections… at
// the end, where models come from. The body is the registered `model.picker` entry.
import { Link } from "@tanstack/react-router"
import { type ReactNode, useCallback, useId, useMemo, useRef, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { SlotOutlet, defineSlot } from "../../slots.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Field } from "../../ui/Field.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import {
  type PickerBodyProps,
  PickerFooterButton,
  PickerPopover,
  PickerSearch,
  pickerRowClass
} from "./PickerParts.tsx"
import { MODEL_SORTS, type ModelSort, modelConnection, modelRows, modelsInOrder } from "./modelList.ts"
import { type ModelSelection, useModelUse } from "./modelSelection.ts"
import type { ModelChoice } from "../chat/modelChoices.ts"
import { VirtualModelList, type ModelListNavigation } from "./VirtualModelList.tsx"

export interface ModelPickerProps extends PickerBodyProps {
  readonly selection: ModelSelection
}

/** The registered model picker body (`model.picker`); a plugin may replace or add to it. */
export const modelPickers = defineSlot<ModelPickerProps>("model.picker")

const CONNECTIONS_HINT = "Open Settings → Connections to add a connection or change one; Back returns to this chat"

/** Where models come from: Settings → Connections, in this tab, so Back returns to the chat. */
export function ConnectionsLink({ className, children }: { className: string; children: ReactNode }) {
  return (
    <Tooltip label={CONNECTIONS_HINT}>
      <Link to="/settings/connections" className={className}>
        {children}
      </Link>
    </Tooltip>
  )
}

export function ModelPicker({ selection, focusRef, focus, onChosen }: ModelPickerProps) {
  const { prefs, change, error, ready } = useViewPrefs()
  const [query, setQuery] = useState("")
  const [connection, setConnection] = useState("")
  // A pin never moves the button under the pointer. Its new place applies on reopening.
  const [orderPins, setOrderPins] = useState<Readonly<Record<string, boolean>> | null>(ready ? prefs.modelPins : null)
  if (orderPins === null && ready) setOrderPins(prefs.modelPins)
  const search = useRef<HTMLInputElement>(null)
  const searchRef = focus === "search" ? focusRef : search
  const navigation = useRef<ModelListNavigation>(null)
  const listId = useId()
  const { models, value } = selection
  const used = useMemo(() => {
    const merged = new Map(selection.used)
    for (const [id, at] of Object.entries(prefs.modelRecent)) merged.set(id, Math.max(at, merged.get(id) ?? 0))
    return merged
  }, [selection.used, prefs.modelRecent])
  const catalog = useMemo(() => models.filter((model) => model.value.includes(" ")), [models])
  const choices = useMemo(() => models.filter((model) => !model.value.includes(" ")), [models])
  const connections = useMemo(
    () =>
      [
        ...new Map(
          catalog.map((model) => {
            const entry = modelConnection(model)
            return [entry.id, entry]
          })
        ).values()
      ].sort((a, b) => a.name.localeCompare(b.name)),
    [catalog]
  )
  const ordered = useMemo(() => modelsInOrder(prefs.modelSort, "", catalog, used), [prefs.modelSort, catalog, used])
  const rows = useMemo(
    () => modelRows(ordered, prefs.modelSort, query, connection, orderPins ?? prefs.modelPins, used, true),
    [ordered, prefs.modelSort, query, connection, orderPins, prefs.modelPins, used]
  )
  const choose = useCallback(
    (next: string) => {
      if (next.includes(" ")) {
        const at = Date.now()
        void change({ modelRecent: { ...prefs.modelRecent, [next]: at } }, { modelRecent: { [next]: at } })
      }
      onChosen()
      if (next !== value) void selection.choose(next)
    },
    [change, prefs.modelRecent, onChosen, value, selection]
  )
  return (
    <div data-model-picker="" className="flex min-h-0 flex-col gap-2">
      <ChatLock lock={selection.lock} kind="model" />
      <Field label="Find a model" labelHidden className="shrink-0">
        <PickerSearch
          label="Find a model"
          placeholder="Search name, id or provider"
          value={query}
          onChange={setQuery}
          inputRef={searchRef}
          navigate={(key) => {
            if (key === "ArrowDown") navigation.current?.focusCurrent()
            else navigation.current?.chooseFirst()
          }}
          controls={listId}
        />
      </Field>
      <label className="flex shrink-0 items-center gap-2 text-sm">
        <span>Connection</span>
        <Tooltip label="Show models from one connection, or all connections">
          <select
            aria-label="Connection"
            value={connection}
            onChange={(event) => setConnection(event.target.value)}
            className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-text outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <option value="">All connections</option>
            {connections.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </Tooltip>
      </label>
      <Segmented<ModelSort>
        label="Sort models"
        value={prefs.modelSort}
        onValueChange={(modelSort) => void change({ modelSort })}
        options={MODEL_SORTS}
      />
      {choices.map((choice) => (
        <Tooltip key={choice.value} label={choice.description ?? `Choose ${choice.label}`}>
          <button type="button" className={pickerRowClass} onClick={() => choose(choice.value)}>
            {choice.label}
          </button>
        </Tooltip>
      ))}
      <VirtualModelList
        ref={navigation}
        fallbackFocus={searchRef}
        key={`${query}:${connection}:${prefs.modelSort}`}
        id={listId}
        rows={rows}
        value={value}
        used={used}
        pins={prefs.modelPins}
        pinsReady={ready}
        onChoose={choose}
        focusRef={focus === "current" ? focusRef : undefined}
        onPin={(id) =>
          void change(
            { modelPins: { ...prefs.modelPins, [id]: !prefs.modelPins[id] } },
            { modelPins: { [id]: !prefs.modelPins[id] } }
          )
        }
      />
      {models.length === 0 && (
        <p className="text-sm text-muted">
          No connection lists a model yet. Add a connection, and its models show here.
        </p>
      )}
      <ErrorAlert error={selection.error ?? error} />
      <ConnectionsLink className={pickerRowClass}>
        <Icon name={models.length === 0 ? "plus" : "sliders"} size={14} />
        {models.length === 0 ? "Add a connection…" : "Manage connections…"}
      </ConnectionsLink>
    </div>
  )
}

/** A settings field uses the same replaceable picker, with its own list and write. */
export function ModelSelect({
  items,
  value,
  onValueChange,
  placeholder = "None",
  ariaLabel = "Choose a model",
  clear
}: {
  items: ReadonlyArray<ModelChoice>
  value: string | null
  onValueChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
  /** A row under the list that takes the choice off (back to `placeholder`), shown while one is chosen. */
  clear?: { readonly label: string; readonly hint: string; readonly onClear: () => void }
}) {
  const { used, refresh } = useModelUse()
  const current = items.find((item) => item.value === value)
  const selection: ModelSelection = {
    loaded: true,
    value,
    current,
    models: items.filter((item) => !item.hidden || item.value === value),
    used,
    choose: async (next) => {
      onValueChange(next)
      return true
    },
    refresh,
    error: null
  }
  return (
    <ModelPickerPopover
      selection={selection}
      trigger={<span className="truncate">{current?.label ?? (value ? "Model unavailable" : placeholder)}</span>}
      triggerLabel={ariaLabel}
      hint="Choose a model from your connections"
      side="bottom"
      {...(clear && value
        ? {
            footer: (close: () => void) => (
              <PickerFooterButton
                hint={clear.hint}
                onClick={() => {
                  close()
                  clear.onClear()
                }}
              >
                {clear.label}
              </PickerFooterButton>
            )
          }
        : {})}
    />
  )
}

/** The picker in its popover, opened by `trigger`: the registered body, then the host's `footer` rows. */
export function ModelPickerPopover({
  selection,
  trigger,
  triggerLabel,
  triggerClassName,
  hint,
  side,
  footer
}: {
  selection: ModelSelection
  trigger: ReactNode
  triggerLabel: string
  triggerClassName?: string
  hint?: ReactNode
  side?: "top" | "bottom"
  footer?: (close: () => void) => ReactNode
}) {
  // Read account pins and sort while the host loads its model lists, before opening.
  useViewPrefs()
  // A quick reopen can interrupt the exit animation before the old body unmounts.
  const [opening, setOpening] = useState(0)
  return (
    <PickerPopover
      title="Model"
      trigger={trigger}
      triggerLabel={triggerLabel}
      {...(triggerClassName === undefined ? {} : { triggerClassName })}
      hint={hint}
      {...(side === undefined ? {} : { side })}
      onOpen={() => {
        setOpening((previous) => previous + 1)
        selection.refresh()
      }}
      {...(footer === undefined ? {} : { footer })}
    >
      {(body) => <SlotOutlet key={opening} slot={modelPickers} props={{ ...body, selection }} />}
    </PickerPopover>
  )
}
