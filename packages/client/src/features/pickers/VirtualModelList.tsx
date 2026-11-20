// Bounded DOM even for catalogs containing thousands of models. Keyboard navigation can
// reach unmounted rows; the focused row stays mounted while the pointer scrolls elsewhere.
// Every row has the same shape: the name, then one muted line of facts; the chosen row is
// tinted and checked, and a model's pin sits at its end.
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual"
import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref, type RefObject } from "react"
import type { ModelChoice } from "../chat/modelChoices.ts"
import { Icon } from "../../ui/Icon.tsx"
import { ToggleIconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { modelConnection, modelDetail, modelName, modelTime, modelWindow, modelWindowHint } from "./modelList.ts"

export type ModelRow =
  | { readonly heading: string; readonly key: string }
  /** `mixed`: the section spans connections, so the row names its connection. */
  | { readonly model: ModelChoice; readonly key: string; readonly mixed: boolean }
  /** A choice that isn't a model ("No model"): its description is its line. */
  | { readonly choice: ModelChoice; readonly key: string }

export interface ModelListNavigation {
  readonly focusCurrent: () => void
  readonly chooseFirst: () => void
}

const ROW = 48
const HEADING = 28
const sizeOf = (row: ModelRow) => ("heading" in row ? HEADING : ROW)
const valueOf = (row: ModelRow) => ("model" in row ? row.model.value : "choice" in row ? row.choice.value : null)

/** A model's line: its window and last use, and its connection where the section doesn't say it. */
function Facts({ model, used, mixed }: { model: ModelChoice; used: number | undefined; mixed: boolean }) {
  const window = modelWindow(model)
  const parts = [
    window && (
      <span key="window" className={model.window?.assumed ? "text-warning" : ""}>
        {window}
      </span>
    ),
    used !== undefined && <span key="used">{modelDetail(used)}</span>,
    mixed && <span key="connection">{modelConnection(model).name}</span>
  ].filter(Boolean)
  return (
    <span className="truncate text-xs text-muted">
      {parts.flatMap((part, i) => (i === 0 ? [part] : [<span key={`dot${i}`}> · </span>, part]))}
    </span>
  )
}

export function VirtualModelList({
  ref,
  fallbackFocus,
  id,
  rows,
  value,
  used,
  pins,
  pinsReady,
  onChoose,
  onPin,
  focusRef
}: {
  ref?: Ref<ModelListNavigation>
  fallbackFocus: RefObject<HTMLElement | null>
  id: string
  rows: ReadonlyArray<ModelRow>
  value: string | null
  used: ReadonlyMap<string, number>
  pins: Readonly<Record<string, boolean>>
  pinsReady: boolean
  onChoose: (value: string) => void
  onPin: (value: string) => void
  focusRef?: RefObject<HTMLElement | null> | undefined
}) {
  "use no memo"
  const parent = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(-1)
  const windowed = rows.length > 60
  const current = Math.max(
    0,
    rows.findIndex((row) => value !== null && valueOf(row) === value)
  )
  const offsetOf = (index: number) => rows.slice(0, index).reduce((total, row) => total + sizeOf(row), 0)
  // eslint-disable-next-line react-hooks/incompatible-library -- this component opts out of compiler memoization
  const virtualizer = useVirtualizer({
    count: rows.length,
    enabled: windowed,
    getScrollElement: () => parent.current,
    getItemKey: (index) => rows[index]!.key,
    estimateSize: (index) => sizeOf(rows[index]!),
    overscan: 3,
    initialRect: { width: 400, height: 288 },
    initialOffset: () => (focusRef ? offsetOf(current) : 0),
    rangeExtractor: (range) => {
      const indices = defaultRangeExtractor(range)
      if (focused >= 0 && focused < rows.length && !indices.includes(focused)) indices.push(focused)
      return indices.sort((a, b) => a - b)
    }
  })
  const move = (index: number, direction: number) => {
    while (index >= 0 && index < rows.length && "heading" in rows[index]!) index += direction
    if (index < 0) {
      fallbackFocus.current?.focus()
      return
    }
    if (index >= rows.length) return
    setFocused(index)
    if (windowed) virtualizer.scrollToIndex(index, { align: "auto" })
    // A mounted row may already be the retained index after focus returned to search.
    parent.current?.querySelector<HTMLElement>(`[data-model-index="${index}"] [role=radio]`)?.focus()
  }
  useImperativeHandle(ref, () => ({
    focusCurrent: () => move(current, 1),
    chooseFirst: () => {
      const first = rows.find((row) => "model" in row)
      if (first && "model" in first) onChoose(first.model.value)
    }
  }))
  useLayoutEffect(() => {
    if (focused >= 0)
      parent.current?.querySelector<HTMLElement>(`[data-model-index="${focused}"] [role=radio]`)?.focus()
  }, [focused])
  return (
    <div
      ref={parent}
      id={id}
      role="radiogroup"
      data-layout-audit-ignore="inset: Rows are full-width hover targets, edge to edge with the search field, their text 8 px in"
      aria-label="Model"
      className="scroll-thumb-only max-h-80 min-h-12 shrink overflow-y-auto"
      onKeyDown={(event) => {
        const index = Number(
          (event.target as HTMLElement).closest<HTMLElement>("[data-model-index]")?.dataset.modelIndex ?? -1
        )
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
        event.preventDefault()
        if (event.key === "Home") move(0, 1)
        else if (event.key === "End") move(rows.length - 1, -1)
        else move(index + (event.key === "ArrowDown" ? 1 : -1), event.key === "ArrowDown" ? 1 : -1)
      }}
    >
      {rows.length === 0 && <p className="px-2 py-2 text-sm text-muted">No matching models.</p>}
      <div
        className="relative w-full"
        style={{ height: windowed ? virtualizer.getTotalSize() : offsetOf(rows.length) }}
      >
        {(windowed
          ? virtualizer.getVirtualItems()
          : rows.map((row, index) => ({ index, key: row.key, start: offsetOf(index), size: sizeOf(row) }))
        ).map((item) => {
          const row = rows[item.index]!
          if ("heading" in row)
            return (
              <div
                key={item.key}
                data-model-index={item.index}
                data-model-heading=""
                className="absolute left-0 flex w-full items-end px-2 pb-1 text-xs font-medium text-muted"
                style={{ top: item.start, height: item.size }}
              >
                <span className="truncate">{row.heading}</span>
              </div>
            )
          const choice = "model" in row ? row.model : row.choice
          const checked = choice.value === value
          const pinned = pins[choice.value] === true
          return (
            <div
              key={item.key}
              data-model-index={item.index}
              data-picker-row={choice.value}
              className={`absolute left-0 flex w-full items-center gap-1 rounded-md pe-2 ${checked ? "bg-accent/10" : "hover:bg-hover"}`}
              style={{ top: item.start, height: item.size }}
            >
              <Tooltip
                label={
                  "model" in row
                    ? `Choose ${modelName(row.model)} (${row.model.modelKey ?? row.model.label}, ${modelConnection(row.model).name}). ${modelTime(used.get(row.model.value))}.${modelWindowHint(row.model)}`
                    : (row.choice.description ?? `Choose ${row.choice.label}`)
                }
              >
                <button
                  type="button"
                  role="radio"
                  aria-label={choice.label}
                  aria-checked={checked}
                  {...("model" in row
                    ? { "aria-description": modelDetail(used.get(row.model.value)) }
                    : row.choice.description
                      ? { "aria-description": row.choice.description }
                      : {})}
                  ref={checked ? (focusRef as RefObject<HTMLButtonElement | null>) : undefined}
                  onFocus={() => setFocused(item.index)}
                  onClick={() => onChoose(choice.value)}
                  className="flex h-full min-w-0 flex-1 flex-col justify-center rounded-md px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
                >
                  <span className={`truncate text-sm ${checked ? "font-medium" : ""}`}>
                    {"model" in row ? modelName(row.model) : row.choice.label}
                  </span>
                  {"model" in row ? (
                    <Facts model={row.model} used={used.get(row.model.value)} mixed={row.mixed} />
                  ) : (
                    row.choice.description && (
                      <span className="truncate text-xs text-muted">{row.choice.description}</span>
                    )
                  )}
                </button>
              </Tooltip>
              {checked && (
                <span aria-hidden className="flex size-6 shrink-0 items-center justify-center text-accent">
                  <Icon name="check" size={16} />
                </span>
              )}
              {"model" in row ? (
                <ToggleIconButton
                  quiet
                  label={`${pinned ? "Unpin" : "Pin"} ${row.model.label}`}
                  icon="pin"
                  pressed={pinned}
                  disabled={!pinsReady}
                  hint={
                    pinsReady
                      ? pinned
                        ? `Unpin ${modelName(row.model)}: it leaves the top of the list.`
                        : `Pin ${modelName(row.model)} to the top of the list.`
                      : "Model pins are loading"
                  }
                  onClick={() => onPin(row.model.value)}
                />
              ) : (
                // The same end as a model's row, so every row's check lines up.
                <span aria-hidden className="size-8 shrink-0" />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
