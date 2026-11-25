/** Allow for rounding in the browser's scroll height, viewport height and offset. */
export const NATIVE_END_PX = 2

const SCROLL_IDLE_MS = 120
const scrollRange = (list: HTMLElement) => Math.max(0, list.scrollHeight - list.clientHeight)
export const atNativeEnd = (list: HTMLElement) => scrollRange(list) - list.scrollTop <= NATIVE_END_PX

type Direction = -1 | 0 | 1

const trackDirection = (list: HTMLElement, event: PointerEvent, range: number): Direction => {
  if (range <= NATIVE_END_PX) return 0
  // The chat scrollbar has no buttons and sets a minimum thumb length. The native thumb
  // occupies the visible fraction of the track, subject to that minimum.
  const minimum = Number.parseFloat(getComputedStyle(list, "::-webkit-scrollbar-thumb").height)
  if (!Number.isFinite(minimum)) return 0
  const height = list.clientHeight
  const length = Math.min(height, Math.max(minimum, Math.round((height * height) / list.scrollHeight)))
  const progress = Math.min(1, Math.max(0, list.scrollTop / range))
  const top = Math.floor((height - length) * progress)
  return event.offsetY < top ? -1 : event.offsetY >= top + length ? 1 : 0
}

interface ScrollInput {
  offset: number
  atEnd: boolean
  direction: Direction
}

/** Observe native input and its scroll events before the virtualizer adjusts measured rows. */
export function trackScrollInput(
  list: HTMLElement,
  {
    following,
    suspend,
    keepEnd,
    settle
  }: {
    following: () => boolean
    suspend: () => void
    keepEnd: () => void
    settle: (atEnd: boolean, save: boolean) => void
  }
) {
  let input: ScrollInput | null = null
  let scrollbar: {
    id: number
    thumb: { y: number; rangeAtPress: number; rangeAtMove: number; movedAt: number } | null
  } | null = null
  let selection: { id: number; y: number } | null = null
  let middle: { id: number; y: number; released: boolean; dragged: boolean } | null = null
  let touchY: number | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const rawPointer = window.isSecureContext && "onpointerrawupdate" in window
  const listeners = new AbortController()
  const passive = { signal: listeners.signal, passive: true }
  const capture = { ...passive, capture: true }

  const start = (direction: Direction, atEnd = atNativeEnd(list)) => {
    input ??= { offset: list.scrollTop, atEnd, direction }
    input.direction = direction
    // Let the first pixels of a native scroll away from the end through.
    if (direction < 0) suspend()
  }
  const sample = () => {
    if (input === null) return false
    const offset = list.scrollTop
    const range = scrollRange(list)
    let atEnd = range - offset <= NATIVE_END_PX
    const delta = offset - Math.min(input.offset, range)
    // Chromium can move a stationary thumb after a resize. Raw pointer motion still
    // arrives when the native drag consumes pointermove.
    const thumb = scrollbar?.thumb
    if (thumb && rawPointer) {
      const moved = performance.now() - thumb.movedAt <= SCROLL_IDLE_MS
      if (range !== thumb.rangeAtPress && !moved) return false
      // A stream may extend the range between the thumb's movement and its scroll event.
      if (moved && input.direction > 0 && thumb.rangeAtMove - offset <= NATIVE_END_PX) atEnd = true
      if (moved && atEnd) input.atEnd = true
    }
    input.offset = offset
    // A clamp to a smaller range, or an offset going against the input, is a layout correction.
    if (delta === 0 || delta * input.direction < 0) return false
    // A downwards scroll starting at the end cannot take the reader into history.
    if (delta > 0 && input.direction > 0 && input.atEnd) return false
    if (!atEnd) suspend()
    input.atEnd = atEnd
    return true
  }
  const finish = (save = true) => {
    clearTimeout(timer)
    if (input === null) return
    sample()
    const atEnd = input.atEnd
    input = null
    settle(atEnd, save)
  }
  const waitForScroll = () => {
    clearTimeout(timer)
    if (scrollbar === null && selection === null && middle === null && touchY === null) {
      timer = setTimeout(finish, SCROLL_IDLE_MS)
    }
  }

  const onWheel = (event: WheelEvent) => {
    if (event.deltaY === 0 || event.ctrlKey) return
    if (middle !== null) endMiddle()
    // A passive wheel listener can see the offset after the compositor has scrolled.
    const direction = event.deltaY < 0 ? -1 : 1
    start(direction, (direction > 0 && following()) || atNativeEnd(list))
    waitForScroll()
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    const target = event.target
    if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]")) return
    if (event.key === " " && target instanceof Element && target.closest("button, [role=button]")) return
    const up = ["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.shiftKey && [" ", "Tab"].includes(event.key))
    if (!up && !["ArrowDown", "PageDown", "End", " ", "Tab"].includes(event.key)) return
    start(up ? -1 : 1, following() || atNativeEnd(list))
    waitForScroll()
  }
  const onTouchStart = (event: TouchEvent) => {
    touchY = event.touches[0]?.clientY ?? null
  }
  const onTouchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY
    if (y === undefined || touchY === null || touchY === y) return
    start(y > touchY ? -1 : 1, following() || atNativeEnd(list))
    touchY = y
    waitForScroll()
  }
  const onTouchEnd = () => {
    touchY = null
    if (input !== null) waitForScroll()
  }
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch" || !(event.target instanceof Node) || !list.contains(event.target)) return
    if (event.button === 1) {
      if (event.defaultPrevented || (event.target instanceof Element && event.target.closest("a[href]"))) return
      if (scrollRange(list) <= NATIVE_END_PX) return
      middle = { id: event.pointerId, y: event.clientY, released: false, dragged: false }
      start(0, following() || atNativeEnd(list))
    } else if (event.button === 0 && event.target === list && event.offsetX >= list.clientWidth) {
      const range = scrollRange(list)
      const direction = rawPointer ? trackDirection(list, event, range) : 0
      scrollbar = {
        id: event.pointerId,
        thumb:
          direction === 0 ? { y: event.clientY, rangeAtPress: range, rangeAtMove: range, movedAt: -Infinity } : null
      }
      start(direction, following() || atNativeEnd(list))
      waitForScroll()
    } else if (event.button === 0) {
      selection = { id: event.pointerId, y: event.clientY }
    }
  }
  const onPointerMove = (event: Event) => {
    if (!(event instanceof PointerEvent)) return
    const thumb = scrollbar?.id === event.pointerId ? scrollbar.thumb : null
    if (thumb && thumb.y !== event.clientY) {
      if (input !== null) input.direction = event.clientY < thumb.y ? -1 : 1
      thumb.y = event.clientY
      thumb.rangeAtMove = scrollRange(list)
      thumb.movedAt = performance.now()
    }
    if (middle?.id === event.pointerId) {
      const dy = event.clientY - middle.y
      if (Math.abs(dy) > 8) {
        if (!middle.released) middle.dragged = true
        start(dy < 0 ? -1 : 1)
      }
    } else if (selection?.id === event.pointerId && Math.abs(event.clientY - selection.y) > 5) {
      const { top, bottom } = list.getBoundingClientRect()
      if (event.clientY < top || event.clientY > bottom) start(event.clientY < top ? -1 : 1)
    }
  }
  const endMiddle = () => {
    if (middle === null) return
    middle = null
    finish()
  }
  const onPointerEnd = (event: PointerEvent) => {
    if (middle?.id === event.pointerId) {
      // Chromium consumes the press that stops autoscroll and still delivers its release.
      if (middle.released || middle.dragged || event.type === "pointercancel") endMiddle()
      else if (event.button === 1) middle.released = true
    }
    if (scrollbar?.id === event.pointerId) {
      if (scrollbar.thumb !== null) finish()
      scrollbar = null
      // Native page scrolling from a track press can still be in flight on release.
      if (input !== null) waitForScroll()
    }
    if (selection?.id === event.pointerId) {
      selection = null
      if (input !== null) waitForScroll()
    }
  }
  const stopMiddleOnPress = (event: PointerEvent) => {
    if (middle === null) return
    endMiddle()
    // Chromium consumes the canceling press. Other browsers can deliver it to the list.
    if (event.button === 1) canceledPress = event
  }
  let canceledPress: PointerEvent | null = null
  const pointerDown = (event: PointerEvent) => {
    if (event !== canceledPress) onPointerDown(event)
  }
  const onScroll = () => {
    if (sample()) waitForScroll()
    keepEnd()
  }

  list.addEventListener("wheel", onWheel, passive)
  list.addEventListener("keydown", onKey, passive)
  list.addEventListener("touchstart", onTouchStart, passive)
  list.addEventListener("touchmove", onTouchMove, passive)
  list.addEventListener("touchend", onTouchEnd, passive)
  list.addEventListener("touchcancel", onTouchEnd, passive)
  list.addEventListener("pointerdown", pointerDown, passive)
  list.addEventListener("scroll", onScroll, capture)
  window.addEventListener("pointermove", onPointerMove, capture)
  if (rawPointer) window.addEventListener("pointerrawupdate", onPointerMove, capture)
  window.addEventListener("pointerdown", stopMiddleOnPress, capture)
  window.addEventListener("pointerup", onPointerEnd, capture)
  window.addEventListener("pointercancel", onPointerEnd, capture)
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") endMiddle()
    },
    capture
  )
  window.addEventListener("blur", endMiddle, passive)
  return {
    flush: () => finish(false),
    dispose: () => {
      clearTimeout(timer)
      listeners.abort()
    }
  }
}
