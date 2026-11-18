import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { FOOT_DEFAULT, FOOT_MIN, sidebarFootLayout, type FootKind, type FootPresence } from "./sidebarFootLayout.ts"
import { useLayoutNumber, useLayoutParam, writeLayoutParam } from "../../tabLayoutParams.ts"

// The sidebar foot's heights and closed sections: layout params in the browser tab's URL
// (`tabLayoutParams.ts`), absent at their defaults (registered by the characters feature).
export const FOOT_PARAMS = {
  /** A section the user closed: "closed". */
  open: { branch: "fb", split: "fs" },
  /** A section's height the user dragged, whole pixels. */
  height: { branch: "fbh", split: "fsh" }
} as const

type State = ReturnType<typeof sidebarFootLayout> & {
  expanded: Record<FootKind, boolean>
  change: (kind: FootKind, value: number | null) => void
  toggle: (kind: FootKind) => void
}
const FootContext = createContext<State | null>(null)

/** Only actual footer sections take space; Chats flexes into everything left. */
export function SidebarFeet({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState({ normal: 0, focused: 0 })
  const [focused, setFocused] = useState<FootKind | null>(null)
  const [presence, setPresence] = useState<FootPresence>({ branch: "absent", split: "absent" })
  const branchHeight = useLayoutNumber(FOOT_PARAMS.height.branch, 1)
  const splitHeight = useLayoutNumber(FOOT_PARAMS.height.split, 1)
  const preferred: Record<FootKind, number> = {
    branch: branchHeight === null ? FOOT_DEFAULT.branch : Math.max(FOOT_MIN.branch, branchHeight),
    split: splitHeight === null ? FOOT_DEFAULT.split : Math.max(FOOT_MIN.split, splitHeight)
  }
  const expanded = {
    branch: useLayoutParam(FOOT_PARAMS.open.branch) !== "closed",
    split: useLayoutParam(FOOT_PARAMS.open.split) !== "closed"
  }
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return
    const measure = () => {
      const list = parent.querySelector<HTMLElement>("[data-shell-list]")
      const controls = list ? list.getBoundingClientRect().top - parent.getBoundingClientRect().top : 136
      const rows = list ? [...list.querySelectorAll<HTMLElement>("[data-fork-row]")].slice(0, 3) : []
      const last = rows[2]
      const threeRows =
        list && last ? last.getBoundingClientRect().bottom - list.getBoundingClientRect().top + list.scrollTop : 322
      const first = rows[0]
      const oneRow =
        list && first ? first.getBoundingClientRect().bottom - list.getBoundingClientRect().top + list.scrollTop : 126
      setAvailable((previous) => {
        const next = {
          normal: Math.max(0, parent.clientHeight - controls - 8 - threeRows),
          focused: Math.max(0, parent.clientHeight - controls - 8 - oneRow)
        }
        return previous.normal === next.normal && previous.focused === next.focused ? previous : next
      })
      const next = Object.fromEntries(
        (["branch", "split"] as const).map((kind) => {
          const section = ref.current?.querySelector<HTMLElement>(`[data-foot-section="${kind}"]`)
          return [kind, !section ? "absent" : section.dataset.footList === "true" ? "list" : "header"]
        })
      ) as FootPresence
      setPresence((previous) => (previous.branch === next.branch && previous.split === next.split ? previous : next))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    const content = new MutationObserver(measure)
    content.observe(parent, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-foot-list", "data-foot-section"]
    })
    measure()
    return () => {
      observer.disconnect()
      content.disconnect()
    }
  }, [])
  const effectiveExpanded = focused ? { branch: focused === "branch", split: focused === "split" } : expanded
  const layout = sidebarFootLayout(
    focused ? available.focused : available.normal,
    preferred,
    effectiveExpanded,
    presence
  )
  const change = (kind: FootKind, value: number | null) => {
    const next =
      value === null ? FOOT_DEFAULT[kind] : Math.round(Math.max(FOOT_MIN[kind], Math.min(layout.max[kind], value)))
    writeLayoutParam(FOOT_PARAMS.height[kind], value === null || next === FOOT_DEFAULT[kind] ? null : String(next))
  }
  const toggle = (kind: FootKind) => {
    const next = layout.collapsed[kind]
    const nextExpanded = { ...expanded, [kind]: next }
    const normal = sidebarFootLayout(available.normal, preferred, nextExpanded, presence)
    setFocused(next && (focused !== null || normal.collapsed[kind]) ? kind : null)
    writeLayoutParam(FOOT_PARAMS.open[kind], next ? null : "closed")
  }
  return (
    <FootContext value={{ ...layout, expanded, change, toggle }}>
      <div ref={ref} data-sidebar-feet className="flex shrink-0 flex-col gap-2">
        {children}
      </div>
    </FootContext>
  )
}

export function useBranchHeight(kind: FootKind) {
  const state = useContext(FootContext)
  if (!state) throw new Error("Sidebar foot sections require SidebarFeet")
  return {
    height: state.height[kind],
    min: FOOT_MIN[kind],
    max: state.max[kind],
    collapsed: state.collapsed[kind],
    expanded: state.expanded[kind],
    change: (next: number) => state.change(kind, next),
    reset: () => state.change(kind, null),
    toggle: () => state.toggle(kind)
  }
}
