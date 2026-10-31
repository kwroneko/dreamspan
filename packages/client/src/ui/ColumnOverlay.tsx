import { Dialog } from "@base-ui/react/dialog"
import { type ReactNode, useLayoutEffect, useState } from "react"

/** A nonmodal editor confined to its column; surrounding panels remain usable. */
export function ColumnOverlay({
  children,
  onClose,
  page = false,
  label = "Preset editor"
}: {
  children: ReactNode
  onClose: () => void
  page?: boolean
  /** Its accessible name: what it edits. */
  label?: string
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!page || !container) return
    const main = container.closest("main")
    if (!main) return
    const measure = () => {
      const box = main.getBoundingClientRect()
      container.style.setProperty("--preset-overlay-left", `${box.left}px`)
      container.style.setProperty("--preset-overlay-top", `${box.top}px`)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(main)
    addEventListener("resize", measure)
    measure()
    return () => {
      observer.disconnect()
      removeEventListener("resize", measure)
    }
  }, [page, container])
  return (
    <div ref={setContainer} className="contents">
      {container && (
        <Dialog.Root
          open
          modal={false}
          disablePointerDismissal
          onOpenChange={(open) => {
            if (!open) onClose()
          }}
        >
          <Dialog.Portal container={container}>
            <Dialog.Popup
              aria-label={label}
              className={`${page ? "fixed top-[var(--preset-overlay-top,0px)] right-0 bottom-0 left-[var(--preset-overlay-left,0px)]" : "absolute inset-0"} z-30 flex min-h-0 flex-col bg-canvas text-text shadow-xl outline-none`}
            >
              <Dialog.Title className="sr-only">{label}</Dialog.Title>
              {children}
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </div>
  )
}
