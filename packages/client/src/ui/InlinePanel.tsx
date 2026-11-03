// A panel a button opens in the page, under that button (owner, 2026-11-02): anything a button
// opens inline appears below it, so the button never moves under the cursor. It has the corner
// X of dialogs and sheets (WindowClose), and Escape inside it closes it; the button that opened
// it shows itself pressed while it's open (`aria-pressed`, `pressedButtonClass`).
import type { ReactNode } from "react"
import { WindowClose } from "./WindowClose.tsx"

/** A toggle button's look while the panel it opens is open. */
export const pressedButtonClass =
  "aria-pressed:bg-surface-raised aria-pressed:text-text aria-pressed:ring-1 aria-pressed:ring-border"

export function InlinePanel({
  id,
  title,
  onClose,
  className = "",
  children
}: {
  id?: string
  /** Its heading and accessible name. */
  title: string
  onClose: () => void
  className?: string
  children: ReactNode
}) {
  return (
    <section
      id={id}
      aria-label={title}
      className={`flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface p-2 ${className}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      <div className="-mt-1 -mr-1 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <WindowClose onClick={onClose} />
      </div>
      {children}
    </section>
  )
}
