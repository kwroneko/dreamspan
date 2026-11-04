import { type ReactElement, useEffect, useLayoutEffect, useRef, useState } from "react"
import { MenuItem } from "./Menu.tsx"
import { type Portrait, usePortraitViewer } from "./Portrait.tsx"
import { Tooltip } from "./Tooltip.tsx"

/** The whole header is a pointer and keyboard handle; controls still receive ordinary clicks. */
export function ViewerHeader({ portrait, children }: { portrait: Portrait; children: ReactElement }) {
  const viewer = usePortraitViewer()!
  const live = useRef(viewer)
  const tracking = useRef<AbortController | null>(null)
  const [indicator, setIndicator] = useState<{ left: number; top: number; width: number } | null>(null)
  useLayoutEffect(() => {
    live.current = viewer
  })
  useEffect(() => () => tracking.current?.abort(), [])
  const index = viewer.shown.findIndex((e) => e.portrait.id === portrait.id)
  return (
    <Tooltip label="Drag to preview where this image will move on release.">
      <div
        data-viewer-header
        tabIndex={0}
        aria-label={`${portrait.name}: image header`}
        className="cursor-grab outline-none select-none focus-visible:ring-2 focus-visible:ring-focus"
        style={{ touchAction: "none" }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || !e.altKey) return
          const to = e.key === "ArrowUp" ? index - 1 : e.key === "ArrowDown" ? index + 1 : e.key === "Home" ? 0 : null
          if (to === null) return
          e.preventDefault()
          viewer.move(portrait.id, to)
        }}
        onPointerDown={(e) => {
          if (
            e.button !== 0 ||
            !e.currentTarget.contains(e.target as Node) ||
            (e.target as Element).closest("button,input,[role='slider'],[role='menuitem']")
          )
            return
          const column = e.currentTarget.closest("[data-portrait-column]")
          if (!column) return
          tracking.current?.abort()
          const controller = new AbortController()
          tracking.current = controller
          const id = e.pointerId
          const x = e.clientX,
            y = e.clientY
          const nodes = [...column.querySelectorAll<HTMLElement>("[data-portrait-viewer]")]
          const others = nodes
            .filter((node) => node !== e.currentTarget.closest("[data-portrait-viewer]"))
            .map((node) => node.getBoundingClientRect())
          const bounds = column.getBoundingClientRect()
          let moving = false
          let target = index
          e.currentTarget.setPointerCapture(id)
          const end = (commit: boolean) => {
            controller.abort()
            setIndicator(null)
            if (commit && moving && target !== index) live.current.move(portrait.id, target)
          }
          window.addEventListener(
            "pointermove",
            (event) => {
              if (event.pointerId !== id) return
              if (!moving && Math.hypot(event.clientX - x, event.clientY - y) < 6) return
              moving = true
              event.preventDefault()
              target = others.filter((box) => event.clientY >= box.top + box.height / 2).length
              const top = others[target]?.top ?? others.at(-1)?.bottom ?? bounds.top
              setIndicator(target === index ? null : { left: bounds.left, top: top - 1, width: bounds.width })
            },
            { signal: controller.signal, passive: false }
          )
          window.addEventListener(
            "pointerup",
            (event) => {
              if (event.pointerId === id) end(true)
            },
            { signal: controller.signal }
          )
          window.addEventListener(
            "pointercancel",
            (event) => {
              if (event.pointerId === id) end(false)
            },
            { signal: controller.signal }
          )
          window.addEventListener("blur", () => end(false), { signal: controller.signal })
        }}
      >
        {children}
        {indicator && (
          <div
            data-viewer-drop-indicator
            data-layout-overlay="Drop indicator previews the image's destination"
            className="pointer-events-none fixed z-30 h-0.5 bg-accent"
            style={indicator}
          />
        )}
      </div>
    </Tooltip>
  )
}

/** Stack moves share the viewer's ordinary options menu. */
export function ViewerMoves({ portrait }: { portrait: Portrait }) {
  const viewer = usePortraitViewer()!
  const index = viewer.shown.findIndex((e) => e.portrait.id === portrait.id)
  return (
    <>
      <MenuItem
        disabled={index === 0}
        description={
          index === 0 ? "This image is already first." : "Move this image up one place (Alt+↑ on the header)."
        }
        onClick={() => viewer.move(portrait.id, index - 1)}
      >
        Move up
      </MenuItem>
      <MenuItem
        disabled={index === viewer.shown.length - 1}
        description={
          index === viewer.shown.length - 1
            ? "This image is already last."
            : "Move this image down one place (Alt+↓ on the header)."
        }
        onClick={() => viewer.move(portrait.id, index + 1)}
      >
        Move down
      </MenuItem>
      <MenuItem
        disabled={index === 0}
        description={
          index === 0 ? "This image is already first." : "Move this image to the top (Alt+Home on the header)."
        }
        onClick={() => viewer.move(portrait.id, 0)}
      >
        Move to top
      </MenuItem>
    </>
  )
}
