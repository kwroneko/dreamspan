// A list the user reorders: drag an item's handle with a mouse, finger or pen, or focus the
// handle and press the up and down arrows. The handle keeps its focus as its item moves.
import { type ReactNode, useId, useRef, useState } from "react"

interface Drag {
  readonly from: number
  /** Where the item would land: the index it would have once dropped. */
  readonly to: number
}

export function SortableList<Item>({
  items,
  itemKey,
  itemLabel,
  onMove,
  label,
  namesAsHandles = false,
  onSelect,
  children
}: {
  items: ReadonlyArray<Item>
  itemKey: (item: Item) => string
  /** Names the item in its handle's label: "Move <label>". */
  itemLabel: (item: Item) => string
  onMove: (from: number, to: number) => void
  label: string
  namesAsHandles?: boolean
  onSelect?: (item: Item) => void
  /** An item's row, with its handle to place. */
  children: (item: Item, handle: ReactNode) => ReactNode
}) {
  const rows = useRef(new Map<string, HTMLLIElement>())
  const handles = useRef(new Map<string, HTMLButtonElement>())
  const [drag, setDrag] = useState<Drag | null>(null)
  const hint = useId()

  /** The index a pointer at `y` would drop at, from the rows' middles. */
  const target = (y: number) => {
    const index = items.findIndex((item) => {
      const box = rows.current.get(itemKey(item))?.getBoundingClientRect()
      return box !== undefined && y < box.top + box.height / 2
    })
    return index === -1 ? items.length : index
  }

  const handleFor = (item: Item, index: number) => {
    const key = itemKey(item)
    return (
      <button
        type="button"
        ref={(element) => {
          if (element) handles.current.set(key, element)
          else handles.current.delete(key)
        }}
        onClick={() => onSelect?.(item)}
        aria-label={`Move ${itemLabel(item)}`}
        aria-describedby={hint}
        className={`${namesAsHandles ? "w-full gap-2 px-1 text-left text-xs" : "size-8"} flex min-h-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus active:cursor-grabbing`}
        onKeyDown={(event) => {
          const to = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : null
          if (to === null || to < 0 || to >= items.length) return
          event.preventDefault()
          onMove(index, to)
          // Moving a row in the document takes the focus from it: the moved handle gets it back.
          requestAnimationFrame(() => handles.current.get(key)?.focus())
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          setDrag({ from: index, to: index })
        }}
        onPointerMove={(event) => {
          if (drag !== null) setDrag({ ...drag, to: target(event.clientY) })
        }}
        onPointerUp={() => {
          if (drag === null) return
          // Dropping below itself counts the gap it leaves.
          const to = drag.to > drag.from ? drag.to - 1 : drag.to
          setDrag(null)
          if (to !== drag.from) onMove(drag.from, to)
        }}
        onPointerCancel={() => setDrag(null)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="5.5" cy="3.5" r="1.25" />
          <circle cx="10.5" cy="3.5" r="1.25" />
          <circle cx="5.5" cy="8" r="1.25" />
          <circle cx="10.5" cy="8" r="1.25" />
          <circle cx="5.5" cy="12.5" r="1.25" />
          <circle cx="10.5" cy="12.5" r="1.25" />
        </svg>
        {namesAsHandles && <span className="min-w-0 flex-1 break-words">{itemLabel(item)}</span>}
      </button>
    )
  }

  return (
    <>
      <p id={hint} className="sr-only">
        Drag to reorder, or press the up and down arrows.
      </p>
      <ol aria-label={label} className="flex flex-col">
        {items.map((item, index) => {
          const key = itemKey(item)
          const before = drag !== null && drag.to === index && drag.to !== drag.from && drag.to !== drag.from + 1
          const after = drag !== null && index === items.length - 1 && drag.to === items.length && drag.from !== index
          return (
            <li
              key={key}
              ref={(element) => {
                if (element) rows.current.set(key, element)
                else rows.current.delete(key)
              }}
              className={`border-y-2 border-transparent ${before ? "border-t-accent" : ""} ${after ? "border-b-accent" : ""} ${
                drag?.from === index ? "opacity-60" : ""
              }`}
            >
              {children(item, handleFor(item, index))}
            </li>
          )
        })}
      </ol>
    </>
  )
}
