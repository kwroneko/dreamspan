// Which registered entry a component belongs to, for state that outlives the component (the
// URL's `open` list, editor/durable.tsx): when that entry goes away (disabled, unregistered or
// replaced), what it had open goes with it, so restoring the entry doesn't reopen its dialog.
// A host that renders registry entries (`SlotOutlet`, `CardSurface`) wraps each in `OwnedBy`.
import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { Registry } from "./registry.ts"

export interface PlaceOwner {
  /** Whether the entry, and every entry around it, is still the one in effect. */
  readonly present: () => boolean
}

const OwnerContext = createContext<PlaceOwner | null>(null)

/** The entry the nearest host rendered this under; null outside any. */
export const usePlaceOwner = () => useContext(OwnerContext)

export function OwnedBy<A extends { readonly id: string }>({
  registry,
  entry,
  children
}: {
  registry: Registry<A>
  entry: A
  children: ReactNode
}) {
  const parent = useContext(OwnerContext)
  const owner = useMemo<PlaceOwner>(
    () => ({ present: () => registry.get(entry.id) === entry && (parent?.present() ?? true) }),
    [registry, entry, parent]
  )
  return <OwnerContext.Provider value={owner}>{children}</OwnerContext.Provider>
}
