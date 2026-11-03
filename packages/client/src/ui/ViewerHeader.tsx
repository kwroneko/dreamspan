import { type ReactElement, useEffect, useLayoutEffect, useRef, useState } from "react"
import { ContextMenu, MenuItem } from "./Menu.tsx"
import { type Portrait, usePortraitViewer } from "./Portrait.tsx"
import { Tooltip } from "./Tooltip.tsx"

/** The whole header is a pointer and keyboard handle; controls still receive ordinary clicks. */
export function ViewerHeader({ portrait, children }: { portrait: Portrait; children: ReactElement }) {
  const viewer = usePortraitViewer()!
  const [menu, setMenu] = useState(false)
  const drag = useRef<{ id: number; x: number; y: number; moving: boolean } | null>(null)
  const live = useRef(viewer)
  const tracking = useRef<AbortController | null>(null)
  useLayoutEffect(() => {
    live.current = viewer
  })
  useEffect(() => () => tracking.current?.abort(), [])
  const index = viewer.shown.findIndex((e) => e.portrait.id === portrait.id)
  const last = viewer.shown.length - 1
  const move = (to: number) => viewer.move(portrait.id, to)
  return (
    <ContextMenu
      label="Image stack actions"
      open={menu}
      onOpenChange={(open) => {
        setMenu(open)
        if (open) {
          drag.current = null
          tracking.current?.abort()
        }
      }}
      trigger={
        <Tooltip label="Drag to reorder · right-click for more">
          <div
            data-viewer-header
            tabIndex={0}
            aria-label={`${portrait.name}: image header`}
            className="cursor-grab outline-none select-none focus-visible:ring-2 focus-visible:ring-focus"
            style={{ touchAction: "none" }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || !e.altKey) return
              if (e.key === "ArrowUp") {
                e.preventDefault()
                move(index - 1)
              }
              if (e.key === "ArrowDown") {
                e.preventDefault()
                move(index + 1)
              }
              if (e.key === "Home") {
                e.preventDefault()
                move(0)
              }
            }}
            onPointerDown={(e) => {
              if (e.button !== 0 || (e.target as Element).closest("button,input,[role='slider'],[role='menuitem']"))
                return
              drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moving: false }
              tracking.current?.abort()
              const controller = new AbortController()
              tracking.current = controller
              const column = e.currentTarget.closest("[data-portrait-column]")
              const end = () => {
                drag.current = null
                controller.abort()
              }
              window.addEventListener(
                "pointermove",
                (event) => {
                  const d = drag.current
                  if (!d || d.id !== event.pointerId) return
                  if (!d.moving && Math.hypot(event.clientX - d.x, event.clientY - d.y) < 6) return
                  d.moving = true
                  event.preventDefault()
                  const viewers = [...(column?.querySelectorAll<HTMLElement>("[data-portrait-viewer]") ?? [])]
                  const target = viewers.findIndex((node) => {
                    const box = node.getBoundingClientRect()
                    return event.clientY >= box.top && event.clientY < box.bottom
                  })
                  const current = live.current.shown.findIndex((entry) => entry.portrait.id === portrait.id)
                  if (target >= 0 && target !== current) live.current.move(portrait.id, target)
                },
                { signal: controller.signal, passive: false }
              )
              window.addEventListener("pointerup", end, { signal: controller.signal })
              window.addEventListener("pointercancel", end, { signal: controller.signal })
            }}
          >
            {children}
          </div>
        </Tooltip>
      }
    >
      <MenuItem
        disabled={index === 0}
        description={
          index === 0 ? "This image is already first." : "Move this image up one place (Alt+↑ on its focused header)."
        }
        onClick={() => move(index - 1)}
      >
        Move up <span className="text-xs text-muted">Alt+↑</span>
      </MenuItem>
      <MenuItem
        disabled={index === last}
        description={
          index === last
            ? "This image is already last."
            : "Move this image down one place (Alt+↓ on its focused header)."
        }
        onClick={() => move(index + 1)}
      >
        Move down <span className="text-xs text-muted">Alt+↓</span>
      </MenuItem>
      <MenuItem
        disabled={index === 0}
        description="Move this image to the top (Alt+Home on its focused header)."
        onClick={() => move(0)}
      >
        Move to top <span className="text-xs text-muted">Alt+Home</span>
      </MenuItem>
      <MenuItem description="Close this image viewer." onClick={() => viewer.close(portrait.id)}>
        Close
      </MenuItem>
    </ContextMenu>
  )
}
