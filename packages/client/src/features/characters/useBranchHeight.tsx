import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { useSession } from "../../session.ts"
import { FOOT_DEFAULT, FOOT_MIN, sidebarFootLayout, type FootKind } from "./sidebarFootLayout.ts"

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* Preferences remain usable in memory. */
  }
}
const openKey = (kind: FootKind, userId: string) =>
  kind === "branch" ? `rp.openChatBranches.${userId}` : `rp.splitChatsOpen.${userId}`
const heightKey = (kind: FootKind, userId: string) => `rp.${kind}Height.${userId}`

type State = ReturnType<typeof sidebarFootLayout> & {
  expanded: Record<FootKind, boolean>
  change: (kind: FootKind, value: number | null) => void
  toggle: (kind: FootKind) => void
}
const FootContext = createContext<State | null>(null)

/** Both slots remain reserved even when the current chat has no split list. */
export function SidebarFeet({ children, active }: { children: ReactNode; active: boolean }) {
  const userId = useSession().user.id
  const ref = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(0)
  const [preferred, setPreferred] = useState(
    () =>
      Object.fromEntries(
        (["branch", "split"] as const).map((kind) => {
          const saved = Number(read(heightKey(kind, userId)))
          return [kind, Number.isFinite(saved) && saved > 0 ? Math.max(FOOT_MIN[kind], saved) : FOOT_DEFAULT[kind]]
        })
      ) as Record<FootKind, number>
  )
  const [expanded, setExpanded] = useState(() => ({
    branch: read(openKey("branch", userId)) !== "collapsed",
    split: read(openKey("split", userId)) !== "collapsed"
  }))
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return
    const measure = () => {
      const list = parent.querySelector<HTMLElement>("[data-shell-list]")
      const controls = list ? list.getBoundingClientRect().top - parent.getBoundingClientRect().top : 136
      // Keep a small usable Chats viewport. Its contents never enter this calculation.
      setAvailable(Math.max(0, parent.clientHeight - controls - 8 - 48))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    measure()
    return () => observer.disconnect()
  }, [])
  const layout = sidebarFootLayout(available, preferred, expanded)
  const change = (kind: FootKind, value: number | null) => {
    const next =
      value === null ? FOOT_DEFAULT[kind] : Math.round(Math.max(FOOT_MIN[kind], Math.min(layout.max[kind], value)))
    setPreferred((previous) => ({ ...previous, [kind]: next }))
    write(heightKey(kind, userId), value === null ? null : String(next))
  }
  const toggle = (kind: FootKind) => {
    const next = !expanded[kind]
    setExpanded((previous) => ({ ...previous, [kind]: next }))
    write(openKey(kind, userId), next ? "open" : "collapsed")
  }
  return (
    <FootContext value={{ ...layout, expanded, change, toggle }}>
      <div
        ref={ref}
        data-sidebar-feet
        style={active ? { height: layout.total } : undefined}
        className="flex shrink-0 flex-col gap-2"
      >
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
