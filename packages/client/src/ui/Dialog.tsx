// Modal dialogs. Base UI traps focus inside, closes on Escape and returns focus to the
// trigger. An alert dialog asks for a decision, so it doesn't close on an outside click.
import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog"
import { Dialog as BaseDialog } from "@base-ui/react/dialog"
import { useRef, type ReactNode } from "react"
import { Button } from "./Button.tsx"
import { WindowClose } from "./WindowClose.tsx"
import { useAway } from "./away.ts"

const backdrop =
  "fixed inset-0 z-40 min-h-dvh bg-overlay transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none supports-[-webkit-touch-callout:none]:absolute"
const popup =
  "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-surface p-5 text-text shadow-xl outline-none transition-[scale,opacity] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none"

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  wide = false,
  placement = "center",
  insetScroll = false,
  finalFocus,
  initialFocus,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  /** Room for two columns side by side on a wide screen. */
  wide?: boolean
  /** Top placement keeps inline expansions from moving their trigger. */
  placement?: "center" | "top"
  /** Keep the scrollbar inside the padding, with equal visible content insets. */
  insetScroll?: boolean
  /** Override focus restoration when an action navigates outside the dialog. */
  finalFocus?: (() => boolean) | undefined
  /** The element to focus on open, such as the field a link opened the dialog at. */
  initialFocus?: (() => HTMLElement | null) | undefined
  children: ReactNode
}) {
  const content = useRef<HTMLDivElement>(null)
  const away = useAway()
  const focusOnOpen = () => {
    if (initialFocus) return initialFocus() ?? true
    const root = content.current
    // Keep explicit autofocus; otherwise start in the content, skipping help and the X.
    if (!root || (document.activeElement !== root && root.contains(document.activeElement))) return true
    const controls = [
      ...root.querySelectorAll<HTMLElement>("button, input, textarea, select, a[href], [tabindex]")
    ].filter(
      (element) =>
        element.tabIndex >= 0 &&
        !element.matches(":disabled, [data-window-close]") &&
        !element.closest("[hidden], [inert]") &&
        element.getClientRects().length > 0
    )
    return controls.find((element) => !element.hasAttribute("data-about-hint")) ?? true
  }
  const body = (
    <>
      <div className="flex shrink-0 items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1 [overflow-wrap:anywhere]">
          <BaseDialog.Title className="text-base font-semibold">{title}</BaseDialog.Title>
          {description && <BaseDialog.Description className="text-sm text-muted">{description}</BaseDialog.Description>}
        </div>
        <WindowClose onClick={() => onOpenChange(false)} />
      </div>
      {children}
    </>
  )
  return (
    <BaseDialog.Root open={open && !away} onOpenChange={(next) => onOpenChange(next)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={backdrop} />
        <BaseDialog.Popup
          data-layout-overlay="Modal dialog covers the page"
          ref={content}
          finalFocus={finalFocus}
          initialFocus={focusOnOpen}
          className={`${popup} ${wide ? "sm:max-w-5xl" : ""} ${placement === "top" ? "top-4! translate-y-0! [scrollbar-gutter:stable]" : ""} ${insetScroll ? "overflow-y-hidden! [scrollbar-gutter:auto]! [container-type:inline-size]" : ""}`}
        >
          {insetScroll ? (
            <div className="-my-5 -mr-5 min-h-0 overflow-y-auto py-5 [scrollbar-gutter:stable]" data-dialog-scroll>
              <div className="flex w-[100cqw] flex-col gap-4" data-dialog-content>
                {body}
              </div>
            </div>
          ) : (
            body
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

/** The row of buttons at the bottom of a dialog: stacked on phones, right-aligned otherwise. */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">{children}</div>
}

/** Asks before something that can't be taken back in one click, such as a deletion. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmDisabled,
  pending,
  onConfirm,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description: ReactNode
  confirmLabel: string
  confirmDisabled?: boolean
  pending?: boolean | undefined
  onConfirm: () => void
  /** Extra content, such as an error from the last attempt. */
  children?: ReactNode
}) {
  const away = useAway()
  return (
    <BaseAlertDialog.Root open={open && !away} onOpenChange={(next) => onOpenChange(next)}>
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop className={backdrop} />
        <BaseAlertDialog.Popup data-layout-overlay="Confirmation dialog covers the page" className={popup}>
          <div className="flex flex-col gap-1">
            <BaseAlertDialog.Title className="text-base font-semibold">{title}</BaseAlertDialog.Title>
            <BaseAlertDialog.Description className="text-sm text-muted">{description}</BaseAlertDialog.Description>
          </div>
          {children}
          <DialogActions>
            <BaseAlertDialog.Close render={<Button hint="Closes this confirmation without applying changes." />}>
              Cancel
            </BaseAlertDialog.Close>
            <Button
              hint={confirmLabel}
              variant="danger"
              disabled={confirmDisabled}
              pending={pending}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </DialogActions>
        </BaseAlertDialog.Popup>
      </BaseAlertDialog.Portal>
    </BaseAlertDialog.Root>
  )
}
