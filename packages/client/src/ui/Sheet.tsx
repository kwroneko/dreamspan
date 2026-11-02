// A full-height sheet over the page, for phones: what a side panel is on a wide screen.
// Base UI traps focus inside, closes it on Escape and returns focus to the trigger.
import { Dialog as BaseDialog } from "@base-ui/react/dialog"
import { type ReactNode, useRef } from "react"
import { ImageControls } from "./ImageControls.tsx"
import { Button } from "./Button.tsx"

export function Sheet({
  open,
  onOpenChange,
  title,
  closeLabel = "Close",
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Its heading, beside the close button. */
  title: ReactNode
  closeLabel?: string
  /** Fills the rest of the height; it scrolls itself. */
  children: ReactNode
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <BaseDialog.Portal>
        <BaseDialog.Popup
          data-layout-overlay="Modal sheet covers the page"
          initialFocus={closeRef}
          className="fixed inset-0 z-40 flex h-dvh flex-col bg-surface text-text outline-none transition-[translate,opacity] duration-150 data-ending-style:translate-y-4 data-ending-style:opacity-0 data-starting-style:translate-y-4 data-starting-style:opacity-0 motion-reduce:transition-none"
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            <BaseDialog.Title className="min-w-0 flex-1 truncate text-base font-semibold">{title}</BaseDialog.Title>
            <div className="max-sm:order-3 max-sm:flex max-sm:w-full max-sm:justify-end">
              <ImageControls />
            </div>
            <BaseDialog.Close ref={closeRef} render={<Button variant="secondary" />}>
              {closeLabel}
            </BaseDialog.Close>
          </div>
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
