import { Tooltip } from "./Tooltip.tsx"
// A list the user reorders: drag an item's handle with a mouse, finger or pen, or focus the
// handle and press the up and down arrows. The handle keeps its focus as its item moves. Held
// near the top or bottom of the list's scrolling container, a drag scrolls it.
import {
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from "react"

interface Drag {
  readonly from: number
  /** Where the item would land: the index it would have once dropped. */
  readonly to: number
}

interface PointerState {
  y: number
  from: number
  scroller: HTMLElement | null
}

interface HandleState<Item> {
  readonly items: ReadonlyArray<Item>
  readonly itemKey: (item: Item) => string
  readonly onMove: (from: number, to: number) => void
  readonly onSelect: ((item: Item) => void) | undefined
  readonly drag: Drag | null
  readonly target: (y: number) => number
}

/** The nearest ancestor that scrolls vertically. */
const scrollerOf = (element: HTMLElement) => {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY
    if ((overflow === "auto" || overflow === "scroll") && parent.scrollHeight > parent.clientHeight) return parent
  }
  return null
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
  const handlesRef = useRef(new Map<string, HTMLButtonElement>())
  const [drag, setDrag] = useState<Drag | null>(null)
  const hint = useId()
  /**
   * While dragging: the pointer's height, where it was pressed, and the container that scrolls
   * under it. An edge scrolls the list only once the pointer has moved towards it: a handle
   * pressed near the top doesn't scroll the list away under a pointer that hasn't moved, or
   * that is dragging down.
   */
  const pointerRef = useRef<PointerState | null>(null)

  /** The index a pointer at `y` would drop at, from the rows' middles. */
  const target = (y: number) => {
    const index = items.findIndex((item) => {
      const box = rows.current.get(itemKey(item))?.getBoundingClientRect()
      return box !== undefined && y < box.top + box.height / 2
    })
    return index === -1 ? items.length : index
  }

  const latestRef = useRef<HandleState<Item>>({ items, itemKey, onMove, onSelect, drag, target })
  useLayoutEffect(() => {
    latestRef.current = { items, itemKey, onMove, onSelect, drag, target }
  })

  const dragging = drag !== null
  useEffect(() => {
    if (!dragging) return
    let frame = requestAnimationFrame(function step() {
      const held = pointerRef.current
      const box = held?.scroller?.getBoundingClientRect()
      if (held?.scroller && box) {
        // The edges' bands, deeper at the bottom, where a panel's sticky bar may sit.
        const speed =
          held.y < box.top + 48
            ? -Math.ceil((box.top + 48 - held.y) / 4)
            : held.y > box.bottom - 72
              ? Math.ceil((held.y - (box.bottom - 72)) / 4)
              : 0
        const towards = speed < 0 ? held.y < held.from - 4 : held.y > held.from + 4
        if (speed !== 0 && towards) {
          const before = held.scroller.scrollTop
          held.scroller.scrollTop += speed
          if (held.scroller.scrollTop !== before) setDrag((current) => current && { ...current, to: target(held.y) })
        }
      }
      frame = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(frame)
  })

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
              // Where it would land: a bar across the gap, above (or, at the end, below) a row.
              className={`relative border-y-2 border-transparent ${
                before
                  ? "before:absolute before:inset-x-0 before:-top-1 before:z-10 before:h-1 before:rounded-full before:bg-accent"
                  : ""
              } ${
                after
                  ? "after:absolute after:inset-x-0 after:-bottom-1 after:z-10 after:h-1 after:rounded-full after:bg-accent"
                  : ""
              } ${drag?.from === index ? "opacity-50" : ""}`}
            >
              {children(
                item,
                <SortableHandle
                  itemId={key}
                  itemLabel={itemLabel(item)}
                  named={namesAsHandles}
                  hint={hint}
                  handlesRef={handlesRef}
                  pointerRef={pointerRef}
                  latestRef={latestRef}
                  setDrag={setDrag}
                />
              )}
            </li>
          )
        })}
      </ol>
    </>
  )
}

/** Stable handle contents; callbacks resolve the current item/index only when invoked. */
const SortableHandle = memo(SortableHandleContent) as typeof SortableHandleContent

function SortableHandleContent<Item>({
  itemId,
  itemLabel,
  named,
  hint,
  handlesRef,
  pointerRef,
  latestRef,
  setDrag
}: {
  itemId: string
  itemLabel: string
  named: boolean
  hint: string
  handlesRef: RefObject<Map<string, HTMLButtonElement>>
  pointerRef: RefObject<PointerState | null>
  latestRef: RefObject<HandleState<Item>>
  setDrag: Dispatch<SetStateAction<Drag | null>>
}) {
  return (
    <Tooltip label="Moves this item within the list.">
      <button
        type="button"
        ref={(element) => {
          if (element) handlesRef.current.set(itemId, element)
          else handlesRef.current.delete(itemId)
        }}
        onClick={() => {
          const state = latestRef.current
          const index = state.items.findIndex((item) => state.itemKey(item) === itemId)
          if (index >= 0) state.onSelect?.(state.items[index]!)
        }}
        aria-label={`Move ${itemLabel}`}
        data-layout-audit-ignore={named ? "inset: Named drag handle is the whole outline row" : undefined}
        aria-describedby={hint}
        className={`${named ? "w-full gap-2 px-1 text-left text-xs" : "size-8"} flex min-h-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus active:cursor-grabbing`}
        onKeyDown={(event) => {
          const state = latestRef.current
          const index = state.items.findIndex((item) => state.itemKey(item) === itemId)
          const to = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : null
          if (index < 0 || to === null || to < 0 || to >= state.items.length) return
          event.preventDefault()
          state.onMove(index, to)
          requestAnimationFrame(() => handlesRef.current.get(itemId)?.focus())
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          const state = latestRef.current
          const index = state.items.findIndex((item) => state.itemKey(item) === itemId)
          if (index < 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          pointerRef.current = {
            y: event.clientY,
            from: event.clientY,
            scroller: scrollerOf(event.currentTarget)
          }
          setDrag({ from: index, to: index })
        }}
        onPointerMove={(event) => {
          if (pointerRef.current) pointerRef.current.y = event.clientY
          const { drag, target } = latestRef.current
          if (drag !== null) setDrag({ ...drag, to: target(event.clientY) })
        }}
        onPointerUp={() => {
          const { drag, onMove } = latestRef.current
          if (drag === null) return
          const to = drag.to > drag.from ? drag.to - 1 : drag.to
          pointerRef.current = null
          setDrag(null)
          if (to !== drag.from) onMove(drag.from, to)
        }}
        onPointerCancel={() => {
          pointerRef.current = null
          setDrag(null)
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="5.5" cy="3.5" r="1.25" />
          <circle cx="10.5" cy="3.5" r="1.25" />
          <circle cx="5.5" cy="8" r="1.25" />
          <circle cx="10.5" cy="8" r="1.25" />
          <circle cx="5.5" cy="12.5" r="1.25" />
          <circle cx="10.5" cy="12.5" r="1.25" />
        </svg>
        {named && (
          <span className="min-w-0 flex-1 truncate" title={itemLabel}>
            {itemLabel}
          </span>
        )}
      </button>
    </Tooltip>
  )
}
