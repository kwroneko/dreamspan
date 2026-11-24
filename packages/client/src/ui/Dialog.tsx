// Modal dialogs. Base UI traps focus inside, closes on Escape and returns focus to the
// trigger. An alert dialog asks for a decision, so it doesn't close on an outside click.
import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog"
import { Dialog as BaseDialog } from "@base-ui/react/dialog"
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { Button } from "./Button.tsx"
import { TitledContainer } from "./titledContainer.tsx"
import { WindowClose } from "./WindowClose.tsx"
import { useAway } from "./away.ts"

const backdrop =
  "fixed inset-0 z-40 min-h-dvh bg-overlay transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none supports-[-webkit-touch-callout:none]:absolute"
const popup =
  "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-surface p-5 text-text shadow-xl outline-none transition-[scale,opacity] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none"

/** Marks a layout column a dialog can centre on (the shell's sidebar and centre column). */
export const DIALOG_COLUMN = "data-dialog-column"

interface ColumnBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** The popup's widest width for its size, plus the 1rem gutter each side: what a column must hold. */
const needs = (size: "normal" | "wide", wide: boolean) => (size === "wide" ? 1500 : wide ? 1024 : 512) + 32

/**
 * The box of the column `trigger` sits in, while the dialog fits in it; null otherwise (no
 * trigger, no column, a column narrower than the dialog, or the one-column phone layout), and
 * the dialog centres on the window.
 */
function columnBox(trigger: HTMLElement | null, room: number): ColumnBox | null {
  const column = trigger?.closest<HTMLElement>(`[${DIALOG_COLUMN}]`)
  if (!column || !window.matchMedia("(min-width: 1024px)").matches) return null
  const rect = column.getBoundingClientRect()
  if (rect.width < room || rect.width >= window.innerWidth - 1) return null
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

const sameBox = (a: ColumnBox | null, b: ColumnBox | null) =>
  a === b ||
  (a !== null && b !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height)

/** Follows the trigger's column live: a resized window or sidebar, or a collapsed one. */
function useColumnBox(trigger: RefObject<HTMLElement | null> | undefined, room: number) {
  // Measured in the first render, so the dialog opens where it stays.
  const [box, setBox] = useState(() => (trigger ? columnBox(trigger.current, room) : null))
  useLayoutEffect(() => {
    if (!trigger) return
    const element = trigger.current
    const update = () =>
      setBox((old) => {
        const next = columnBox(element, room)
        return sameBox(old, next) ? old : next
      })
    update()
    const observer = new ResizeObserver(update)
    const column = element?.closest(`[${DIALOG_COLUMN}]`)
    if (column) observer.observe(column)
    observer.observe(document.documentElement)
    window.addEventListener("resize", update)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", update)
    }
  }, [trigger, room])
  return box
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  wide = false,
  size = "normal",
  placement = "center",
  insetScroll = false,
  finalFocus,
  initialFocus,
  centerOnColumnOf,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  /** Room for two columns side by side on a wide screen. */
  wide?: boolean
  /**
   * "wide": most of a large screen, up to min(94vw, 1500px) and nearly its full height, for a
   * form laid out in columns. On a narrow screen it's the usual full-width dialog.
   */
  size?: "normal" | "wide"
  /** Top placement keeps expansions below existing content from moving it. */
  placement?: "center" | "top" | "top-on-phone"
  /** Keep the scrollbar inside the padding, with equal visible content insets. */
  insetScroll?: boolean
  /** Override focus restoration when an action navigates outside the dialog. */
  finalFocus?: (() => boolean) | undefined
  /** The element to focus on open, such as the field a link opened the dialog at. */
  initialFocus?: (() => HTMLElement | null) | undefined
  /**
   * Centre on the layout column this element sits in (the centre column or the sidebar) rather
   * than the window, following its size; the window when the dialog doesn't fit in it.
   */
  centerOnColumnOf?: RefObject<HTMLElement | null> | undefined
  children: ReactNode
}) {
  const content = useRef<HTMLDivElement>(null)
  const column = useColumnBox(centerOnColumnOf, needs(size, wide))
  const columnStyle = column
    ? {
        left: column.left + column.width / 2,
        width: `calc(${column.width}px - 2rem)`,
        ...(placement === "top" ? {} : { top: column.top + column.height / 2 })
      }
    : undefined
  const away = useAway()
  const placementClass =
    placement === "top"
      ? "top-4! translate-y-0! [scrollbar-gutter:stable]"
      : placement === "top-on-phone"
        ? "max-sm:top-4 max-sm:translate-y-0"
        : ""
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
      <TitledContainer title={title}>{children}</TitledContainer>
    </>
  )
  return (
    <BaseDialog.Root open={open && !away} onOpenChange={(next) => onOpenChange(next)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={backdrop} />
        <BaseDialog.Popup
          data-layout-overlay="Modal dialog covers the page"
          ref={content}
          style={columnStyle}
          data-dialog-on-column={column ? "" : undefined}
          finalFocus={finalFocus}
          initialFocus={focusOnOpen}
          className={`${popup} ${size === "wide" ? "sm:max-w-[min(94vw,1500px)] sm:max-h-[calc(100dvh-3rem)]" : wide ? "sm:max-w-5xl" : ""} ${placementClass} ${insetScroll ? "overflow-y-hidden! [scrollbar-gutter:auto]! [container-type:inline-size]" : ""}`}
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
  confirmHint,
  confirmDisabled,
  cancelLabel = "Cancel",
  pending,
  onConfirm,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description: ReactNode
  confirmLabel: string
  /** The button that closes it without the change. */
  cancelLabel?: string
  confirmHint?: string
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
          <TitledContainer title={title}>{children}</TitledContainer>
          <DialogActions>
            <BaseAlertDialog.Close render={<Button hint="Closes this confirmation without applying changes." />}>
              {cancelLabel}
            </BaseAlertDialog.Close>
            <Button
              hint={confirmHint ?? confirmLabel}
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
