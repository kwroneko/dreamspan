// Bounded DOM even for catalogs containing thousands of models. Keyboard navigation can
// reach unmounted rows; the focused row stays mounted while the pointer scrolls elsewhere.
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual"
import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref, type RefObject } from "react"
import type { ModelChoice } from "../chat/modelChoices.ts"
import { Icon } from "../../ui/Icon.tsx"
import { ToggleIconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { modelConnection, modelDetail, modelName, modelTime } from "./modelList.ts"

export type ModelRow =
  { readonly heading: string; readonly key: string } | { readonly model: ModelChoice; readonly key: string }

export interface ModelListNavigation {
  readonly focusCurrent: () => void
  readonly chooseFirst: () => void
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
    rows.findIndex((row) => "model" in row && row.model.value === value)
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- this component opts out of compiler memoization
  const virtualizer = useVirtualizer({
    count: rows.length,
    enabled: windowed,
    getScrollElement: () => parent.current,
    getItemKey: (index) => rows[index]!.key,
    estimateSize: (index) => ("heading" in rows[index]! ? 28 : 72),
    overscan: 3,
    initialRect: { width: 400, height: 288 },
    initialOffset: () =>
      focusRef ? rows.slice(0, current).reduce((total, row) => total + ("heading" in row ? 28 : 72), 0) : 0,
    rangeExtractor: (range) => {
      const indices = defaultRangeExtractor(range)
      if (focused >= 0 && focused < rows.length && !indices.includes(focused)) indices.push(focused)
      return indices.sort((a, b) => a - b)
    }
  })
  const move = (index: number, direction: number) => {
    while (index >= 0 && index < rows.length && !("model" in rows[index]!)) index += direction
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
      aria-label="Model"
      className="h-72 min-h-24 shrink overflow-y-auto p-2"
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
        style={{
          height: windowed
            ? virtualizer.getTotalSize()
            : rows.reduce((total, row) => total + ("heading" in row ? 28 : 72), 0)
        }}
      >
        {(windowed
          ? virtualizer.getVirtualItems()
          : rows.map((row, index) => ({
              index,
              key: row.key,
              start: rows.slice(0, index).reduce((total, prior) => total + ("heading" in prior ? 28 : 72), 0),
              size: "heading" in row ? 28 : 72
            }))
        ).map((item) => {
          const row = rows[item.index]!
          return (
            <div
              key={item.key}
              data-model-index={item.index}
              className="absolute left-0 w-full"
              style={{ top: item.start, height: item.size }}
            >
              {"heading" in row ? (
                <div className="truncate px-2 py-1 text-xs font-medium text-muted">{row.heading}</div>
              ) : (
                <div
                  data-picker-row={row.model.value}
                  className="grid h-full grid-cols-[minmax(0,1fr)_2rem] items-center gap-2 rounded-md pr-2 hover:bg-surface-raised"
                >
                  <Tooltip label={`Choose ${row.model.label}. ${modelTime(used.get(row.model.value))}`}>
                    <button
                      type="button"
                      role="radio"
                      aria-label={row.model.label}
                      aria-checked={row.model.value === value}
                      aria-description={modelDetail(used.get(row.model.value))}
                      ref={row.model.value === value ? (focusRef as RefObject<HTMLButtonElement | null>) : undefined}
                      onFocus={() => setFocused(item.index)}
                      onClick={() => onChoose(row.model.value)}
                      className="grid h-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                    >
                      <span className="text-accent">
                        {row.model.value === value && <Icon name="check" size={14} />}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">{modelName(row.model)}</span>
                        <span className="truncate text-xs text-muted">
                          {modelConnection(row.model).name} · {row.model.modelKey ?? row.model.label}
                        </span>
                        <span className="truncate text-xs text-muted">{modelDetail(used.get(row.model.value))}</span>
                      </span>
                    </button>
                  </Tooltip>
                  <ToggleIconButton
                    label={`${pins[row.model.value] ? "Unpin" : "Pin"} ${row.model.label}`}
                    icon="pin"
                    pressed={pins[row.model.value] === true}
                    disabled={!pinsReady}
                    hint={
                      pinsReady
                        ? `Click to ${pins[row.model.value] ? "unpin" : "pin"} ${row.model.label}`
                        : "Model pins are loading"
                    }
                    onClick={() => onPin(row.model.value)}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
