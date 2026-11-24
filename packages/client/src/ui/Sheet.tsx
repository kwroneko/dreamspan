// A full-height sheet over the page, for phones: what a side panel is on a wide screen. A side
// sheet covers just the left sidebar instead (the menu, on a phone), for one the sidebar opens.
// Base UI traps focus inside, closes it on Escape and returns focus to the trigger.
import { Dialog as BaseDialog } from "@base-ui/react/dialog"
import { type ReactNode, useRef } from "react"
import { ImageControls } from "./ImageControls.tsx"
import { TitledContainer } from "./titledContainer.tsx"
import { WindowClose } from "./WindowClose.tsx"
import { useAway } from "./away.ts"

export function Sheet({
  open,
  onOpenChange,
  title,
  container,
  children,
  initialFocus,
  dedupeLabels = true,
  imageControls = true,
  side = false
}: {
  /**
   * A side sheet, for one the left sidebar opens: at the left edge over a backdrop, exactly over
   * the desktop sidebar at its live width (`--sidebar-width`, set by shell.tsx), on a phone the
   * menu's width (22rem, at most 88% of the window), rather than the whole window.
   */
  side?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Its heading, beside the close button. */
  title: ReactNode
  /** False when the title is a user-supplied name that can coincide with an unrelated label. */
  dedupeLabels?: boolean
  /** Keep a sheet within the landmark it belongs to. */
  container?: HTMLElement | null | undefined
  /** False: no image controls in its header, for a sheet that shows no pictures. */
  imageControls?: boolean
  /** Fills the rest of the height; it scrolls itself. */
  children: ReactNode
  /** Restore a focused control when this sheet replaces a pending chat's sheet. */
  initialFocus?: (() => HTMLElement | null) | undefined
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const away = useAway()
  return (
    <BaseDialog.Root open={open && !away} onOpenChange={(next) => onOpenChange(next)}>
      <BaseDialog.Portal container={container}>
        {side && (
          <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
        )}
        <BaseDialog.Popup
          data-layout-overlay={side ? "Side sheet covers the sidebar" : "Modal sheet covers the page"}
          initialFocus={initialFocus ?? closeRef}
          className={`fixed z-40 flex h-dvh flex-col bg-surface text-text outline-none transition-[translate,opacity] duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none ${side ? "inset-y-0 left-0 w-[min(22rem,88vw)] lg:w-[var(--sidebar-width,22rem)] border-r border-border shadow-xl data-ending-style:-translate-x-4 data-starting-style:-translate-x-4" : "inset-0 data-ending-style:translate-y-4 data-starting-style:translate-y-4"}`}
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            <BaseDialog.Title className="min-w-0 flex-1 truncate text-base font-semibold">{title}</BaseDialog.Title>
            {imageControls && (
              <div className="max-sm:order-3 max-sm:flex max-sm:w-full max-sm:justify-end">
                <ImageControls />
              </div>
            )}
            <WindowClose ref={closeRef} onClick={() => onOpenChange(false)} />
          </div>
          <TitledContainer title={title} dedupeLabels={dedupeLabels}>
            {children}
          </TitledContainer>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
