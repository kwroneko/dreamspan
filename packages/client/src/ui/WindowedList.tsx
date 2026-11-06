// The branch lists share measured windowing: only a viewport and a few neighbours mount.
// Small lists keep their full DOM. The focused row stays mounted even when scrolled away.
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual"
import { useCallback, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react"

export function WindowedList<T>({
  items,
  itemKey,
  renderItem,
  initialIndex = 0,
  initialOffset,
  listLabel,
  ...props
}: {
  items: ReadonlyArray<T>
  itemKey: (item: T) => string
  renderItem: (item: T, index: number) => ReactNode
  initialIndex?: number
  /** Restore a list that was folded away. */
  initialOffset?: () => number
  /** An ordered list when supplied, otherwise a plain stack of rows. */
  listLabel?: string
} & Omit<HTMLAttributes<HTMLDivElement>, "children">) {
  "use no memo"
  const parent = useRef<HTMLDivElement>(null)
  const positioned = useRef(false)
  const windowed = items.length > 60
  const [focused, setFocused] = useState<string | null>(null)
  const focusedIndex = focused === null ? -1 : items.findIndex((item) => itemKey(item) === focused)
  const getItemKey = useCallback((index: number) => itemKey(items[index]!), [items, itemKey])
  // eslint-disable-next-line react-hooks/incompatible-library -- mutable virtualizer; compiler opted out above
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parent.current,
    getItemKey,
    estimateSize: () => 106,
    overscan: 3,
    enabled: windowed,
    initialOffset: () => initialOffset?.() ?? Math.max(0, initialIndex - 1) * 106,
    initialRect: { width: 0, height: 500 },
    rangeExtractor: (range) => {
      const indices = defaultRangeExtractor(range)
      if (focusedIndex >= 0 && !indices.includes(focusedIndex)) indices.push(focusedIndex)
      return indices.sort((a, b) => a - b)
    }
  })
  useLayoutEffect(() => {
    if (positioned.current || items.length === 0) return
    positioned.current = true
    if (initialOffset !== undefined) {
      if (windowed) virtualizer.scrollToOffset(initialOffset())
      else if (parent.current) parent.current.scrollTop = initialOffset()
    } else if (windowed) virtualizer.scrollToIndex(initialIndex, { align: "auto" })
    else parent.current?.querySelector(`[data-index="${initialIndex}"]`)?.scrollIntoView({ block: "nearest" })
  }, [items.length, initialIndex, initialOffset, windowed, virtualizer])
  const rows = windowed
    ? virtualizer.getVirtualItems()
    : items.map((item, index) => ({ index, key: itemKey(item), start: 0 }))
  const List = listLabel ? "ol" : "div"
  const Row = listLabel ? "li" : "div"
  return (
    <div
      {...props}
      ref={parent}
      onFocusCapture={(event) => {
        const index = (event.target as HTMLElement).closest<HTMLElement>("[data-index]")?.dataset.index
        if (index !== undefined && items[Number(index)]) setFocused(itemKey(items[Number(index)]!))
        props.onFocusCapture?.(event)
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null)
        props.onBlurCapture?.(event)
      }}
    >
      <List
        aria-label={listLabel}
        className={windowed ? "relative" : "flex flex-col gap-1"}
        style={windowed ? { height: virtualizer.getTotalSize() } : undefined}
      >
        {rows.map((row) => (
          <Row
            key={row.key}
            data-index={row.index}
            ref={windowed ? virtualizer.measureElement : undefined}
            aria-posinset={listLabel ? row.index + 1 : undefined}
            aria-setsize={listLabel ? items.length : undefined}
            className={windowed ? "absolute left-0 w-full pb-1" : undefined}
            style={windowed ? { top: row.start } : undefined}
          >
            {renderItem(items[row.index]!, row.index)}
          </Row>
        ))}
      </List>
    </div>
  )
}
