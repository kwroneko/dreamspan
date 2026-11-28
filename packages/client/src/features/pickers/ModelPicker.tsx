import { ChatLock } from "./PickerParts.tsx"
// The model picker: the composer's model chip and the Model tab open this same list. A search,
// a connection filter and the sort in one row, the list (a host's own choices such as "No
// model" first, as rows like the models'), and Manage connections… at the end, where models
// come from. The body is the registered `model.picker` entry.
import { Link } from "@tanstack/react-router"
import { type ReactNode, useCallback, useId, useMemo, useRef, useState } from "react"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { ErrorAlert } from "../../actions.tsx"
import { refreshHint, useRefreshModels } from "../connections/refreshModels.ts"
import { connectionsAtom } from "../connections/data.ts"
import { SlotOutlet, defineSlot } from "../../slots.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Field } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
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
import { VirtualModelList, type ModelListNavigation, type ModelRow } from "./VirtualModelList.tsx"

export interface ModelPickerProps extends PickerBodyProps {
  readonly selection: ModelSelection
}

/** The registered model picker body (`model.picker`); a plugin may replace or add to it. */
export const modelPickers = defineSlot<ModelPickerProps>("model.picker")

const ALL = "all connections"

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

interface PinOrder {
  /** The pins the list groups by. */
  readonly pins: Readonly<Record<string, boolean>>
  /** Models pinned or unpinned in this list since `pins` was taken, at their place then. */
  readonly held: Readonly<Record<string, boolean>>
  readonly query: string
  readonly connection: string
}

/** The pins the list groups by next: `previous` while nothing changed but this list's own pins. */
function pinOrder(
  previous: PinOrder | null,
  pins: Readonly<Record<string, boolean>>,
  query: string,
  connection: string
): PinOrder {
  if (!previous || previous.query !== query || previous.connection !== connection)
    return { pins, held: {}, query, connection }
  const differs = (id: string) => !(id in previous.held) && (pins[id] === true) !== (previous.pins[id] === true)
  if (!Object.keys(pins).some(differs) && !Object.keys(previous.pins).some(differs)) return previous
  const held = Object.fromEntries(Object.entries(previous.held).filter(([, pinned]) => pinned))
  const kept = Object.fromEntries(Object.entries(pins).filter(([id]) => !(id in previous.held)))
  return { ...previous, pins: { ...kept, ...held } }
}

export function ModelPicker({ selection, focusRef, focus, onChosen }: ModelPickerProps) {
  const { prefs, change, error, ready } = useViewPrefs()
  const [query, setQuery] = useState("")
  // ALL lists every connection's models; otherwise a connection's id.
  const [connection, setConnection] = useState(ALL)
  // A pin never moves the button under the pointer: the list groups by the pins as they were
  // when it last changed, holding each model pinned or unpinned here where it was. Pins that
  // load or change elsewhere (another tab, another picker) apply at once; a new search, a
  // connection filter or reopening takes every current pin.
  const [order, setOrder] = useState<PinOrder | null>(null)
  const nextOrder = ready ? pinOrder(order, prefs.modelPins, query, connection) : order
  if (nextOrder !== order) setOrder(nextOrder)
  const orderPins = nextOrder?.pins ?? null
  const refreshing = useRefreshModels()
  const allConnections = useAtomValue(connectionsAtom)
  const search = useRef<HTMLInputElement>(null)
  const searchRef = focus === "search" ? focusRef : search
  const navigation = useRef<ModelListNavigation>(null)
  const choosing = useRef(false)
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
    (): ReadonlyArray<ModelRow> => [
      // The host's own choices lead the list, outside the search's matches.
      ...(query.trim() ? [] : choices.map((choice) => ({ choice, key: `choice:${choice.value}` }))),
      ...modelRows(
        ordered,
        prefs.modelSort,
        query,
        connection === ALL ? "" : connection,
        orderPins ?? prefs.modelPins,
        used,
        true
      )
    ],
    [choices, ordered, prefs.modelSort, query, connection, orderPins, prefs.modelPins, used]
  )
  // Refresh reads each connection's model list again: every connection, or the one filtered.
  const known = AsyncResult.isSuccess(allConnections) ? allConnections.value : []
  const refreshTargets = connection === ALL ? known : known.filter((entry) => entry.id === connection)
  const refreshName = connection === ALL ? null : refreshTargets[0]?.name
  const choose = useCallback(
    async (next: string) => {
      if (choosing.current) return
      if (selection.waitForChoice && next !== value) {
        choosing.current = true
        try {
          if (!(await selection.choose(next))) return
        } finally {
          choosing.current = false
        }
      }
      if (next.includes(" ")) {
        const at = Date.now()
        void change({ modelRecent: { ...prefs.modelRecent, [next]: at } }, { modelRecent: { [next]: at } })
      }
      onChosen()
      if (!selection.waitForChoice && next !== value) void selection.choose(next)
    },
    [change, prefs.modelRecent, onChosen, value, selection]
  )
  return (
    <div data-model-picker="" className="flex min-h-0 flex-col gap-2">
      <ChatLock lock={selection.lock} kind="model" />
      <Field label="Find a model" labelHidden className="shrink-0">
        <PickerSearch
          label="Find a model"
          placeholder="Search name, id or connection"
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
      {/* Each in its own Field: inside a settings field's popover, the outer Field's label would name them. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Field label="Connection" labelHidden className="min-w-[11rem] flex-1">
          <Select<string>
            className="max-w-none!"
            value={connection}
            onValueChange={setConnection}
            items={[
              { value: ALL, label: "All connections", description: "Lists the models of every connection." },
              ...connections.map((entry) => ({
                value: entry.id,
                label: entry.name,
                description: `Lists only ${entry.name}'s models.`
              }))
            ]}
          />
        </Field>
        <Field label="Sort models" labelHidden className="shrink-0">
          <Select<ModelSort>
            className="w-auto!"
            value={prefs.modelSort}
            onValueChange={(modelSort) => void change({ modelSort })}
            items={MODEL_SORTS}
            shown={(sort) => (
              <>
                <span className="text-muted">Sort: </span>
                {MODEL_SORTS.find((option) => option.value === sort)?.label}
              </>
            )}
          />
        </Field>
      </div>
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
        onChoose={(next) => void choose(next)}
        focusRef={focus === "current" ? focusRef : undefined}
        onPin={(id) => {
          if (order && !(id in order.held))
            setOrder({ ...order, held: { ...order.held, [id]: order.pins[id] === true } })
          void change(
            { modelPins: { ...prefs.modelPins, [id]: !prefs.modelPins[id] } },
            { modelPins: { [id]: !prefs.modelPins[id] } }
          )
        }}
      />
      {models.length === 0 && (
        <p className="text-sm text-muted">
          No connection lists a model yet. Add a connection, and its models show here.
        </p>
      )}
      <ErrorAlert error={selection.error ?? error ?? refreshing.error} />
      {/* Where models come from, and the button that reads them again: the filter row has no room for it at phone width. */}
      <div className="flex shrink-0 items-center gap-2">
        <ConnectionsLink className={`${pickerRowClass} min-w-0 flex-1 w-auto! shrink!`}>
          <Icon name={models.length === 0 ? "plus" : "sliders"} size={14} />
          {models.length === 0 ? "Add a connection…" : "Manage connections…"}
        </ConnectionsLink>
        <IconButton
          label="Refresh model lists"
          hint={refreshHint(refreshName ?? null)}
          icon="regenerate"
          disabled={refreshing.pending || refreshTargets.length === 0}
          aria-busy={refreshing.pending}
          className={refreshing.pending ? "[&_svg]:animate-spin motion-reduce:[&_svg]:animate-none" : ""}
          onClick={() => void refreshing.run(refreshTargets)}
        />
      </div>
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
