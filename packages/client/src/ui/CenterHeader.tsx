import { defineSlot, SlotOutlet } from "../slots.tsx"
import { createContext, type ReactNode, useContext, useState } from "react"
import { createPortal } from "react-dom"

const HeaderTarget = createContext<HTMLElement | null>(null)

type HeaderProps = {
  children: ReactNode
  className?: string
  /** False where the header places the end controls among its own (a chat's, before its panel toggle). */
  endControls?: boolean
}
export const centerHeaders = defineSlot<HeaderProps>("shell.center.header")
/** Controls at the end of every center header (the workbench's split buttons). */
export const centerHeaderEnd = defineSlot<Record<string, never>>("shell.center.header.end")

export function CenterHeaderEnd() {
  return <SlotOutlet slot={centerHeaderEnd} props={{}} />
}

/**
 * An editor's row in the column header, on a phone: its icon buttons at 24 px with tighter gaps,
 * so the document's name beside them shows whole (a short one never cut, layout audit).
 */
export const compactHeaderControls =
  "max-sm:gap-1 max-sm:[&_button.size-8]:size-6! max-sm:[&_a.size-8]:size-6! max-sm:[&_[data-block-menu]]:size-6! max-sm:[&_[data-save-state]_button]:size-6!"

/** The registered column boundary shared by chats, pages and full editors. */
export function CenterHeader(props: HeaderProps) {
  return <SlotOutlet slot={centerHeaders} only="shell.center-header" props={props} />
}

export function CenterHeaderFrame({ children, className = "", endControls = true }: HeaderProps) {
  return (
    <header
      data-center-header
      className={`@container/header relative flex h-shell-header w-full min-w-0 shrink-0 items-center gap-2 border-b border-border bg-canvas px-2 py-2 sm:gap-3 sm:px-4 ${className}`}
    >
      {children}
      {endControls && <CenterHeaderEnd />}
    </header>
  )
}

/** Keep the header outside a page's padded scroll area. Nested overlays own their header. */
export function CenterHeaderHost({ children, leading }: { children: ReactNode; leading?: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  return (
    <HeaderTarget value={target}>
      <CenterHeader>
        {leading}
        <div
          ref={setTarget}
          className="flex min-w-0 flex-1 items-center gap-2 [&>h1]:truncate [&>h1]:text-base [&>header]:flex [&>header]:w-full [&>header]:min-w-0 [&>header]:items-center [&>header]:justify-between [&_h1]:text-base"
        />
      </CenterHeader>
      {children}
    </HeaderTarget>
  )
}

/** A view contributes its title and document actions to its nearest column header. */
export function CenterHeaderContent({ children }: { children: ReactNode }) {
  const target = useContext(HeaderTarget)
  return target ? createPortal(children, target) : null
}
