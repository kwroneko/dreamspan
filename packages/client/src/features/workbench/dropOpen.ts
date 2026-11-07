// Where something dragged onto the frames would go: into a frame's strip at a place, into the
// frame, or into a new frame on one of its sides (VS Code's: the outer quarter on each side
// splits there). Tabs dragged between strips use it, and so do things that aren't tabs yet (a
// picture dragged from the portrait column, owner 2026-11-07), which open as tabs on release.

/** Where over a frame a drop lands: into it, or into a new frame on that side. */
export type DropZone = "center" | "left" | "right" | "top" | "bottom"

/** The nearest edge's quarter splits there; nearest edge first in a corner. */
export const dropZone = (element: HTMLElement, point: { clientX: number; clientY: number }): DropZone => {
  const box = element.getBoundingClientRect()
  const x = (point.clientX - box.left) / box.width
  const y = (point.clientY - box.top) / box.height
  const edges: Array<[DropZone, number]> = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y]
  ]
  const [zone, distance] = edges.reduce((a, b) => (b[1] < a[1] ? b : a))
  return distance < 0.25 ? zone : "center"
}

interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface DropTarget {
  readonly frameId: string
  readonly zone: DropZone
  /** A place in the frame's strip, for a drop on the strip. */
  readonly index?: number
  /** What to shade while it's over there: the part of the frame it will take, or the strip. */
  readonly box: Box
}

/** The part of a frame's body `zone` takes. */
const zoneBox = (body: DOMRect, zone: DropZone): Box => {
  const half = { width: body.width / 2, height: body.height / 2 }
  if (zone === "left") return { left: body.left, top: body.top, width: half.width, height: body.height }
  if (zone === "right") return { left: body.left + half.width, top: body.top, width: half.width, height: body.height }
  if (zone === "top") return { left: body.left, top: body.top, width: body.width, height: half.height }
  if (zone === "bottom") return { left: body.left, top: body.top + half.height, width: body.width, height: half.height }
  return { left: body.left, top: body.top, width: body.width, height: body.height }
}

/** What's under a point: a frame's strip or body, as a drop target; null elsewhere. */
export const dropTargetAt = (x: number, y: number): DropTarget | null => {
  const element = document.elementFromPoint(x, y)
  const frame = element?.closest<HTMLElement>("[data-frame]")
  const frameId = frame?.dataset["frame"]
  if (!element || !frame || !frameId) return null
  const strip = element.closest<HTMLElement>("[data-tab-strip]")
  if (strip) {
    const index = [...strip.querySelectorAll<HTMLElement>("[data-tab]")].filter((tab) => {
      const box = tab.getBoundingClientRect()
      return x > box.left + box.width / 2
    }).length
    const box = strip.getBoundingClientRect()
    return {
      frameId,
      zone: "center",
      index,
      box: { left: box.left, top: box.top, width: box.width, height: box.height }
    }
  }
  const body = frame.querySelector<HTMLElement>("[data-frame-body]")
  if (!body || !body.contains(element)) return null
  const zone = dropZone(body, { clientX: x, clientY: y })
  return { frameId, zone, box: zoneBox(body.getBoundingClientRect(), zone) }
}
