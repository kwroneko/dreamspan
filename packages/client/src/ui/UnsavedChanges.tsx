// Tab scopes aggregate editor sources, including nested tabs and editors visited earlier.
// A source of one branch of a chat (a chat's own note's store) counts only while its scope shows
// that branch (owner, 2026-11-24): on another branch its note can't be seen, so a dot there
// would point at nothing. The draft stays, and the dot comes back with its branch.
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore
} from "react"
import { Tooltip } from "./Tooltip.tsx"

/** A chat's branch: `forkId` as the chat's view names it. */
export interface UnsavedBranch {
  readonly chatId: string
  readonly forkId: string | null
}

interface UnsavedSource {
  subscribe: (listener: () => void) => () => void
  changed: () => boolean
  /** The branch whose changes these are, for a branch's own; none for an entry's. */
  branch?: () => UnsavedBranch | null
}

export class UnsavedTracker {
  private sources = new Map<string, Map<UnsavedSource, () => void>>()
  private listeners = new Set<() => void>()
  private current: ReadonlySet<string> = new Set()
  private shown: UnsavedBranch | null = null
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = () => this.current
  /** The branch this scope shows: another branch of the same chat's sources don't count. */
  showBranch(branch: UnsavedBranch | null) {
    if (this.shown?.chatId === branch?.chatId && this.shown?.forkId === branch?.forkId) return
    this.shown = branch
    this.update()
  }
  private counts = (source: UnsavedSource) => {
    const branch = source.branch?.() ?? null
    const shown = this.shown
    if (branch !== null && shown !== null && branch.chatId === shown.chatId && branch.forkId !== shown.forkId)
      return false
    return source.changed()
  }
  private update = () => {
    const next = new Set(
      [...this.sources].filter(([, sources]) => [...sources.keys()].some(this.counts)).map(([key]) => key)
    )
    if (next.size === this.current.size && [...next].every((key) => this.current.has(key))) return
    this.current = next
    for (const listener of this.listeners) listener()
  }
  add(key: string, source: UnsavedSource) {
    let sources = this.sources.get(key)
    if (!sources) this.sources.set(key, (sources = new Map()))
    if (!sources.has(source)) sources.set(source, source.subscribe(this.update))
    this.update()
  }
  dispose() {
    for (const sources of this.sources.values()) for (const unsubscribe of sources.values()) unsubscribe()
    this.sources.clear()
    this.update()
  }
}
const Scope = createContext<{ tracker: UnsavedTracker; tab: string } | null>(null)
/** The chat branch shown here (a chat's panel), for nested scopes' trackers. */
const Branch = createContext<UnsavedBranch | null>(null)
export function UnsavedBranchShown({ branch, children }: { branch: UnsavedBranch | null; children: ReactNode }) {
  return <Branch value={branch}>{children}</Branch>
}
export function UnsavedScope({
  tracker,
  tab,
  children
}: {
  tracker: UnsavedTracker
  tab: string
  children: ReactNode
}) {
  return <Scope value={{ tracker, tab }}>{children}</Scope>
}
export function useUnsavedSource(source: UnsavedSource) {
  const scope = useContext(Scope)
  useEffect(() => {
    // Keep observing after a nested editor closes, until the owning navigation goes away.
    // A new view of the same store reuses the source identity.
    if (scope) scope.tracker.add(scope.tab, source)
  }, [scope, source])
}
/** `branch`: the chat branch these tabs show, when they're a chat's; else the enclosing scope's. */
export function useUnsavedTabs(branch?: UnsavedBranch | null) {
  const [tracker] = useState(() => new UnsavedTracker())
  const enclosing = useContext(Branch)
  const shown = branch === undefined ? enclosing : branch
  const chatId = shown?.chatId
  const forkId = shown?.forkId ?? null
  useLayoutEffect(() => {
    tracker.showBranch(chatId === undefined ? null : { chatId, forkId })
  }, [tracker, chatId, forkId])
  const dirty = useSyncExternalStore(tracker.subscribe, tracker.snapshot)
  const [source] = useState<UnsavedSource>(() => ({
    subscribe: tracker.subscribe,
    changed: () => tracker.snapshot().size > 0
  }))
  useUnsavedSource(source)
  useEffect(() => () => tracker.dispose(), [tracker])
  return { tracker, dirty }
}
export function UnsavedDot() {
  return (
    <Tooltip label="Unsaved changes">
      <span
        aria-hidden="true"
        data-unsaved-dot
        className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-accent"
      />
    </Tooltip>
  )
}
