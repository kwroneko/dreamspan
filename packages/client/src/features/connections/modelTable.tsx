// A connection's models as a table (owner, 2026-11-23: lists run to hundreds): a filter by id or
// name, tabs for all, visible and hidden models, and ticks to hide or show many at once. The
// filter and the tab live in the URL; the selection lives in memory, and survives filter and tab
// changes, but Hide and Show only ever apply to selected rows that are shown.
import type { ModelRefresh } from "@dreamspan/shared/api.ts"
import { type Model, type ModelId, pinnedRoute, resolveModel } from "@dreamspan/shared/providers.ts"
import { useAtomValue } from "@effect/atom-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { AsyncResult } from "effect/reactivity"
import { memo, type ReactNode, useCallback, useDeferredValue, useMemo, useRef, useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { RowTick } from "../../ui/Choice.tsx"
import { Input } from "../../ui/Field.tsx"
import { Alert, Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { TabRow } from "../../ui/Tabs.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { usePlaceNotice, usePlaceParam } from "../../usePlaceParam.ts"
import { useOpenChoice, useOpenPlace } from "../editor/durable.tsx"
import { modelsAtom } from "./data.ts"
import { ModelMassEditDialog, selectionDigest } from "./ModelMassEdit.tsx"
import type { ConnectionSectionProps } from "./detail.tsx"
import {
  AddModelDialog,
  capabilityBadges,
  EditModelDialog,
  FeedRoutes,
  shownPrice,
  tokens,
  useEndpointsFetch,
  Value
} from "./models.tsx"

type Tab = "all" | "visible" | "hidden"
const TABS: ReadonlyArray<{ readonly value: Tab; readonly label: string; readonly description: string }> = [
  { value: "all", label: "All", description: "Every model on this connection." },
  { value: "visible", label: "Visible", description: "The models offered where you choose a model." },
  { value: "hidden", label: "Hidden", description: "The models left out of the lists where you choose a model." }
]

interface Row {
  readonly model: Model
  readonly resolved: ReturnType<typeof resolveModel>
  /** The display name and id, lower-cased, for the filter. */
  readonly haystack: string
}

/**
 * One grid for the header and every row. Narrow: the tick, the name with its limits and price
 * wrapping on a line under it (`LIMITS`), the actions. From 36rem of table: a column each, the
 * line's own box gone (`display: contents`), right-aligned numbers.
 */
const GRID =
  "grid grid-cols-[2rem_minmax(0,1fr)_4rem] gap-x-3 @xl:grid-cols-[2rem_minmax(0,1fr)_5.5rem_5.5rem_7.5rem_4rem]"
const TICK = "[grid-area:1/1/3/2] @xl:[grid-area:1/1/2/2]"
const NAME = "min-w-0 [grid-area:1/2/2/3]"
const LIMITS = "flex min-w-0 flex-wrap gap-x-3 [grid-area:2/2/3/3] @xl:contents"
const CONTEXT = "@xl:[grid-area:1/3/2/4] @xl:text-right"
const OUTPUT = "@xl:[grid-area:1/4/2/5] @xl:text-right"
const PRICE = "min-w-0 @xl:[grid-area:1/5/2/6] @xl:text-right"
const ACTIONS = "flex justify-end [grid-area:1/3/3/4] @xl:[grid-area:1/6/2/7]"
/** The header row's height, which the rows scroll under. */
const HEADER_PX = 48

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

const refreshSummary = (refresh: ModelRefresh) =>
  [
    `${refresh.added} added`,
    `${refresh.updated} updated`,
    ...(refresh.missing > 0 ? [`${refresh.missing} no longer listed`] : [])
  ].join(", ")

export function ModelsSection({ connection }: ConnectionSectionProps) {
  const refresh = useAction()
  const [selectedModel, setSelectedModel] = usePlaceParam("model", "")
  // Every model, hidden ones too: the tabs count both.
  const modelAtom = modelsAtom(connection.id, true)
  const modelList = useAtomValue(modelAtom)
  const editing = AsyncResult.isSuccess(modelList)
    ? modelList.value.find((model) => model.id === selectedModel)
    : undefined
  usePlaceNotice(
    selectedModel && AsyncResult.isSuccess(modelList) && editing === undefined
      ? "This model is no longer available on this connection."
      : null
  )
  // A URL place (editor/durable.tsx): a reload opens Add a model again, with the id as typed.
  const [adding, setAdding] = useOpenPlace(`add-model:${connection.id}`)
  const [refreshed, setRefreshed] = useState<ModelRefresh | null>(null)
  return (
    <Card>
      <CardHeader
        title="Models"
        about="* marks your own values, ? values nobody reports; a context size nobody reports is assumed."
        actions={
          <>
            <Button
              pending={refresh.pending}
              hint="Reads the provider’s model list again. Your own settings for each model stay."
              onClick={async () => {
                setRefreshed(null)
                const result = await refresh.run(
                  (client) => client("RefreshModels", { connectionId: connection.id }),
                  ["models"]
                )
                if (result.ok) setRefreshed(result.value)
              }}
            >
              Refresh from provider
            </Button>
            <Button
              variant="ghost"
              hint="Adds one the provider doesn’t list, by its id."
              onClick={() => setAdding(true)}
            >
              Add a model
            </Button>
          </>
        }
      />
      <div className="flex flex-col gap-4">
        {refreshed && (
          <Alert tone="success" title="Model list refreshed">
            <p>{refreshSummary(refreshed)}.</p>
            {refreshed.route && <p className="text-muted">Route: {refreshed.route}</p>}
          </Alert>
        )}
        <ErrorAlert error={refresh.error} title="The model list couldn't be fetched" />
        <AsyncView atom={modelAtom} loading="Loading models…">
          {(models) =>
            models.length === 0 ? (
              <EmptyState title="No models">
                <p>Refresh from the provider, or add one by its id.</p>
              </EmptyState>
            ) : (
              <ModelTable
                key={connection.id}
                connectionId={connection.id}
                models={models}
                compat={connection.compat}
                priceEndpoint={connection.providerSettings?.priceEndpoint === true}
                onEdit={(id) => setSelectedModel(id)}
              />
            )
          }
        </AsyncView>
      </div>
      {editing && (
        <EditModelDialog
          key={editing.id}
          model={editing}
          onOpenChange={(open) => setSelectedModel(open ? editing.id : "")}
        />
      )}
      {adding && <AddModelDialog connectionId={connection.id} onOpenChange={setAdding} />}
    </Card>
  )
}

function ModelTable({
  connectionId,
  models,
  compat,
  priceEndpoint,
  onEdit
}: {
  connectionId: string
  models: ReadonlyArray<Model>
  compat: ConnectionSectionProps["connection"]["compat"]
  priceEndpoint: boolean
  onEdit: (id: ModelId) => void
}) {
  const [tab, setTab] = usePlaceParam<Tab>(
    "models",
    "all",
    TABS.map((entry) => entry.value)
  )
  const [query, changeQuery] = usePlaceParam("q", "")
  const setQuery = (next: string) => changeQuery(next, true)
  // Typing stays quick; the rows follow a moment later on a slow device.
  const needle = useDeferredValue(query).trim().toLowerCase()
  const rows = useMemo(
    () =>
      models.map((model): Row => {
        const resolved = resolveModel(model.key, model.upstream, model.overrides, compat)
        return { model, resolved, haystack: `${resolved.name.value}\n${model.key}`.toLowerCase() }
      }),
    [models, compat]
  )
  const matching = useMemo(
    () => (needle === "" ? rows : rows.filter((row) => row.haystack.includes(needle))),
    [rows, needle]
  )
  const counts = useMemo(() => {
    const hidden = matching.filter((row) => row.model.hidden).length
    return { all: matching.length, visible: matching.length - hidden, hidden }
  }, [matching])
  const shown = useMemo(
    () => (tab === "all" ? matching : matching.filter((row) => row.model.hidden === (tab === "hidden"))),
    [matching, tab]
  )

  // The selection: model ids, kept in memory across filter and tab changes.
  const [picked, setPicked] = useState<ReadonlySet<ModelId>>(new Set())
  const existing = useMemo(() => new Set(models.map((model) => model.id)), [models])
  const selected = useMemo(() => [...picked].filter((id) => existing.has(id)), [picked, existing])
  const selectedShown = shown.filter((row) => picked.has(row.model.id))
  const notShown = selected.length - selectedShown.length
  const toHide = selectedShown.filter((row) => !row.model.hidden).map((row) => row.model.id)
  const toShow = selectedShown.filter((row) => row.model.hidden).map((row) => row.model.id)
  const allShownPicked = shown.length > 0 && selectedShown.length === shown.length
  const someShownPicked = selectedShown.length > 0 && !allShownPicked

  const setMany = (ids: ReadonlyArray<ModelId>, on: boolean) =>
    setPicked((previous) => {
      const next = new Set(previous)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  // Shift-click ticks the range from the last row ticked, as file lists do.
  const anchor = useRef<ModelId | null>(null)
  const toggle = useCallback(
    (id: ModelId, on: boolean, shift: boolean) => {
      const list = shown
      const from = anchor.current === null ? -1 : list.findIndex((row) => row.model.id === anchor.current)
      const to = list.findIndex((row) => row.model.id === id)
      anchor.current = id
      const ids =
        shift && from >= 0 && to >= 0
          ? list.slice(Math.min(from, to), Math.max(from, to) + 1).map((row) => row.model.id)
          : [id]
      setPicked((previous) => {
        const next = new Set(previous)
        for (const each of ids) {
          if (on) next.add(each)
          else next.delete(each)
        }
        return next
      })
    },
    [shown]
  )

  // Edit N…: the dialog's place names the selection; the ids it edits stay in memory, and in its draft.
  const [massEdit, setMassEdit] = useOpenChoice(`model-mass-edit:${connectionId}:`)
  const [massIds, setMassIds] = useState<ReadonlyArray<ModelId> | null>(null)
  const closeMassEdit = useCallback(() => {
    setMassEdit(null)
    setMassIds(null)
  }, [setMassEdit])

  const bulk = useAction()
  const apply = async (ids: ReadonlyArray<ModelId>, hidden: boolean) => {
    if (ids.length === 0) return
    const result = await bulk.run((client) => client("SetModelsHidden", { modelIds: ids, hidden }), ["models"])
    if (!result.ok) {
      showToast({
        title: hidden ? "Couldn’t hide the models" : "Couldn’t show the models",
        description: result.error.message
      })
      return
    }
    // What was acted on leaves the selection; selected rows not shown stay selected.
    setMany(ids, false)
    const changed = result.value.changed
    if (changed.length === 0) return
    showToast({
      title: `${plural(changed.length, "model")} ${hidden ? "hidden" : "shown"}`,
      actions: [
        {
          label: "Undo",
          hint: hidden ? "Show these models again" : "Hide these models again",
          onClick: () =>
            void bulk
              .run((client) => client("SetModelsHidden", { modelIds: changed, hidden: !hidden }), ["models"])
              .then((undo) => {
                if (!undo.ok) showToast({ title: "Couldn’t undo", description: undo.error.message })
              })
        }
      ]
    })
  }

  const table = (
    <ModelRows
      shown={shown}
      picked={picked}
      toggle={toggle}
      priceEndpoint={priceEndpoint}
      onEdit={onEdit}
      header={
        <RowTick
          label="Select all shown"
          hint={
            allShownPicked
              ? "Deselects every model shown here."
              : "Selects every model shown here, by this tab and filter."
          }
          checked={allShownPicked}
          indeterminate={someShownPicked}
          disabled={shown.length === 0}
          onToggle={() =>
            setMany(
              shown.map((row) => row.model.id),
              !allShownPicked
            )
          }
        />
      }
      empty={
        needle !== "" ? (
          <div className="flex flex-col items-start gap-2 p-3 text-sm">
            <p>
              No {tab === "all" ? "" : `${tab} `}models match “{query.trim()}”.
            </p>
            <Button variant="ghost" hint="Clears the filter, so every model shows." onClick={() => setQuery("")}>
              Clear the filter
            </Button>
          </div>
        ) : (
          <p className="p-3 text-sm text-muted">No {tab} models.</p>
        )
      }
    />
  )

  return (
    <div className="@container flex flex-col gap-3">
      <Input
        type="search"
        aria-label="Filter models"
        placeholder="Filter by name or id"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        autoCapitalize="none"
        spellCheck={false}
        fullWidth
      />
      <TabRow
        label="Which models"
        value={tab}
        onValueChange={(next) => setTab(next, true)}
        tabs={TABS.map((entry) => ({
          value: entry.value,
          label: `${entry.label} ${counts[entry.value].toLocaleString()}`,
          description: entry.description
        }))}
      />
      <SelectionBar
        selected={selected.length}
        toEdit={selectedShown.length}
        notShown={notShown}
        toHide={toHide.length}
        toShow={toShow.length}
        anyShown={shown.length > 0}
        pending={bulk.pending}
        onHide={() => void apply(toHide, true)}
        onShow={() => void apply(toShow, false)}
        onInvert={() =>
          setPicked((previous) => {
            const next = new Set(previous)
            for (const row of shown) {
              if (next.has(row.model.id)) next.delete(row.model.id)
              else next.add(row.model.id)
            }
            return next
          })
        }
        onClear={() => setPicked(new Set())}
        onEdit={() => {
          const ids = selectedShown.map((row) => row.model.id)
          setMassIds(ids)
          setMassEdit(selectionDigest(ids))
        }}
      />
      {table}
      {massEdit !== null && (
        <ModelMassEditDialog
          key={massEdit}
          place={`${connectionId}:${massEdit}`}
          ids={massIds}
          models={models}
          onClose={closeMassEdit}
        />
      )}
    </div>
  )
}

/**
 * Bulk Edit, Hide and Show over the selected rows shown, the selection's count, Invert and Clear. Always
 * there at the same height (narrow, room for its buttons on two lines), so ticking the first row moves nothing.
 */
function SelectionBar({
  selected,
  toEdit,
  notShown,
  toHide,
  toShow,
  anyShown,
  pending,
  onHide,
  onShow,
  onInvert,
  onClear,
  onEdit
}: {
  selected: number
  /** The selected rows shown, which Edit N… edits. */
  toEdit: number
  notShown: number
  toHide: number
  toShow: number
  anyShown: boolean
  pending: boolean
  onHide: () => void
  onShow: () => void
  onInvert: () => void
  onClear: () => void
  onEdit: () => void
}) {
  return (
    <div
      role="toolbar"
      aria-label="Selected models"
      data-selection-bar=""
      className="grid h-[7.25rem] grid-cols-[minmax(0,1fr)_auto] content-center items-center gap-x-2 gap-y-1 @xl:h-10 @xl:grid-cols-[auto_auto_minmax(0,1fr)_auto]"
    >
      <p
        aria-live="polite"
        className="truncate text-sm [grid-area:1/1/2/2] @xl:[grid-area:1/3/2/4] @xl:text-right"
        data-selection-count=""
      >
        {selected === 0 ? (
          <span className="text-muted">None selected</span>
        ) : (
          <>
            {selected.toLocaleString()} selected
            {notShown > 0 && <span className="text-muted"> ({notShown.toLocaleString()} not shown)</span>}
          </>
        )}
      </p>
      <Button
        variant="ghost"
        className="[grid-area:1/2/2/3] @xl:[grid-area:1/4/2/5]"
        disabled={selected === 0}
        hint="Unticks every model, shown or not."
        onClick={onClear}
      >
        Clear selection
      </Button>
      <div className="flex flex-wrap gap-2 [grid-area:2/1/3/3] @xl:flex-nowrap @xl:[grid-area:1/1/2/3]">
        <Button
          disabled={toEdit === 0}
          hint={
            toEdit === 0
              ? "Tick models shown here to change their settings together."
              : "Changes settings of the selected models shown here, all at once."
          }
          onClick={onEdit}
        >
          Edit {toEdit.toLocaleString()}…
        </Button>
        <Button
          disabled={toHide === 0}
          pending={pending && toHide > 0}
          hint={
            toHide === 0
              ? "Tick visible models shown here to hide them."
              : "Leaves the selected models shown here out of the lists where you choose a model."
          }
          onClick={onHide}
        >
          Hide {toHide.toLocaleString()}
        </Button>
        <Button
          disabled={toShow === 0}
          pending={pending && toShow > 0}
          hint={
            toShow === 0
              ? "Tick hidden models shown here to show them."
              : "Lists the selected models shown here again where you choose a model."
          }
          onClick={onShow}
        >
          Show {toShow.toLocaleString()}
        </Button>
        <Button
          variant="ghost"
          disabled={!anyShown}
          hint="Ticks the models shown here that aren’t ticked, and unticks those that are."
          onClick={onInvert}
        >
          Invert selection
        </Button>
      </div>
    </div>
  )
}

/** The table: a header that stays in sight, and only the rows in view mounted. */
function ModelRows({
  shown,
  picked,
  toggle,
  priceEndpoint,
  onEdit,
  header,
  empty
}: {
  shown: ReadonlyArray<Row>
  picked: ReadonlySet<ModelId>
  toggle: (id: ModelId, on: boolean, shift: boolean) => void
  priceEndpoint: boolean
  onEdit: (id: ModelId) => void
  header: ReactNode
  empty: ReactNode
}) {
  "use no memo"
  const scroller = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- mutable virtualizer; compiler opted out above
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scroller.current,
    getItemKey: (index) => shown[index]!.model.id,
    estimateSize: () => 52,
    overscan: 8,
    scrollMargin: HEADER_PX,
    initialRect: { width: 0, height: 640 }
  })
  const items = virtualizer.getVirtualItems()
  return (
    <div
      ref={scroller}
      role="table"
      aria-label="Models"
      aria-rowcount={shown.length + 1}
      className="max-h-[min(70vh,44rem)] overflow-y-auto rounded-md border border-border [scrollbar-gutter:stable]"
    >
      <div
        role="rowgroup"
        className="sticky top-0 z-10"
        data-layout-overlay="The table's header row stays over the rows scrolling under it"
      >
        <div
          role="row"
          aria-rowindex={1}
          data-layout-audit-ignore="gap: table columns line up across rows, not evenly apart"
          className={`${GRID} min-h-12 items-center border-b border-border bg-surface-raised px-2 py-2 text-xs font-medium text-muted`}
        >
          <div role="columnheader" className="flex [grid-area:1/1/2/2]">
            {header}
          </div>
          <div role="columnheader" className={NAME}>
            Model
          </div>
          <div role="columnheader" className="hidden @xl:block @xl:[grid-area:1/3/2/4] @xl:text-right">
            Context
          </div>
          <div role="columnheader" className="hidden @xl:block @xl:[grid-area:1/4/2/5] @xl:text-right">
            Output
          </div>
          <div role="columnheader" className="hidden @xl:block @xl:[grid-area:1/5/2/6] @xl:text-right">
            <Tooltip label="Input and output prices, in dollars per million tokens.">
              <span>Price</span>
            </Tooltip>
          </div>
          <div role="columnheader" className="[grid-area:1/3/2/4] @xl:[grid-area:1/6/2/7]">
            <span className="sr-only">Actions</span>
          </div>
        </div>
      </div>
      {shown.length === 0 ? (
        <div role="rowgroup">
          <div role="row">
            <div role="cell">{empty}</div>
          </div>
        </div>
      ) : (
        <div role="rowgroup" className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = shown[item.index]!
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 w-full"
                style={{ top: item.start - HEADER_PX }}
              >
                <ModelRow
                  row={row}
                  index={item.index}
                  checked={picked.has(row.model.id)}
                  toggle={toggle}
                  priceEndpoint={priceEndpoint}
                  onEdit={onEdit}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const ModelRow = memo(function ModelRow({
  row: { model, resolved },
  index,
  checked,
  toggle,
  priceEndpoint,
  onEdit
}: {
  row: Row
  index: number
  checked: boolean
  toggle: (id: ModelId, on: boolean, shift: boolean) => void
  priceEndpoint: boolean
  onEdit: (id: ModelId) => void
}) {
  const hide = useAction()
  const shown = shownPrice(model, resolved, priceEndpoint)
  useEndpointsFetch(model, pinnedRoute({ ...model.upstream.settings, ...model.overrides.settings }.routing) !== null)
  const name = resolved.name.value
  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      data-layout-audit-ignore="gap: table columns line up across rows, not evenly apart"
      data-model-row={model.key}
      className={`${GRID} items-center gap-y-0.5 border-b border-border px-2 py-2 text-sm ${checked ? "bg-hover" : ""}`}
    >
      <div role="cell" className={`${TICK} flex self-start @xl:self-center`}>
        <RowTick
          label={`Select ${model.key}`}
          hint={
            checked ? `Unticks ${name}.` : `Ticks ${name}, to hide, show or edit it with others. Shift ticks a range.`
          }
          checked={checked}
          onToggle={(on, shift) => toggle(model.id, on, shift)}
        />
      </div>
      <div role="cell" className={`${NAME} flex flex-col`}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={`font-medium [overflow-wrap:anywhere] ${model.hidden ? "text-muted" : ""}`}>{name}</span>
          {model.hidden && <Badge size="sm">hidden</Badge>}
          {model.source === "user" && <Badge size="sm">added by you</Badge>}
          {model.missingSince !== null && (
            <Badge size="sm" tone="warning">
              no longer listed
            </Badge>
          )}
          {priceEndpoint && model.upstream.priceFeed?.available === false && (
            <Badge size="sm" tone="warning">
              unavailable on this server
            </Badge>
          )}
          {capabilityBadges(resolved).map(([label]) => (
            <Badge key={label} size="sm" tone="accent">
              {label}
            </Badge>
          ))}
          {resolved.prefill.value === "assistant" && (
            <Badge size="sm" tone="accent">
              prefill
            </Badge>
          )}
        </div>
        {name !== model.key && (
          <span className="font-mono text-xs text-muted [overflow-wrap:anywhere]">{model.key}</span>
        )}
        {priceEndpoint && (
          <span className="text-xs">
            <FeedRoutes feed={model.upstream.priceFeed} />
          </span>
        )}
      </div>
      <div className={LIMITS}>
        <div role="cell" className={`${CONTEXT} tabular-nums whitespace-nowrap`}>
          <span className="text-muted @xl:hidden">Context </span>
          <Value resolved={resolved.context} model={resolved} show={tokens} assumed />
        </div>
        <div role="cell" className={`${OUTPUT} tabular-nums whitespace-nowrap`}>
          <span className="text-muted @xl:hidden">Output </span>
          <Value resolved={resolved.maxOutput} model={resolved} show={tokens} />
        </div>
        <div role="cell" className={`${PRICE} tabular-nums whitespace-nowrap`}>
          {shown && (
            <Tooltip label={`Per million tokens, in and out, ${shown.text}. ${shown.hint}`}>
              <span data-price-source={shown.source}>
                ${shown.price.input} / ${shown.price.output}
              </span>
            </Tooltip>
          )}
        </div>
      </div>
      <div role="cell" className={ACTIONS}>
        <IconButton
          icon="edit"
          label={`Edit ${model.key}`}
          hint="Opens this model’s settings."
          onClick={() => onEdit(model.id)}
        />
        <IconButton
          icon={model.hidden ? "eye" : "eyeOff"}
          label={`${model.hidden ? "Show" : "Hide"} ${model.key}`}
          hint={
            model.hidden
              ? "Lists it again where you choose a model."
              : "Leaves it out of the lists where you choose a model."
          }
          disabled={hide.pending}
          onClick={() =>
            void hide
              .run((client) => client("SetModelHidden", { modelId: model.id, hidden: !model.hidden }), ["models"])
              .then((result) => {
                if (!result.ok)
                  showToast({
                    title: model.hidden ? `Couldn’t show ${name}` : `Couldn’t hide ${name}`,
                    description: result.error.message
                  })
              })
          }
        />
      </div>
    </div>
  )
})
