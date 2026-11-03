// Tab scopes aggregate editor sources, including nested tabs and editors visited earlier.
import { createContext, type ReactNode, useContext, useEffect, useState, useSyncExternalStore } from "react"
import { Tooltip } from "./Tooltip.tsx"

interface UnsavedSource {
  subscribe: (listener: () => void) => () => void
  changed: () => boolean
}

export class UnsavedTracker {
  private sources = new Map<string, Map<UnsavedSource, () => void>>()
  private listeners = new Set<() => void>()
  private current: ReadonlySet<string> = new Set()
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = () => this.current
  private update = () => {
    const next = new Set(
      [...this.sources]
        .filter(([, sources]) => [...sources.keys()].some((source) => source.changed()))
        .map(([key]) => key)
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
export function useUnsavedTabs() {
  const [tracker] = useState(() => new UnsavedTracker())
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
