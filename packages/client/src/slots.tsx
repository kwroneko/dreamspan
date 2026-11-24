// UI slots (spec/PLUGINS.md §8): a place in a screen that renders whatever is registered
// for it, in order, so features add to a screen without the screen knowing them.
import { Fragment, useSyncExternalStore, type ComponentType, type ReactNode } from "react"
import { OwnedBy } from "./placeOwner.tsx"
import { makeRegistry, type Registry } from "./registry.ts"

interface SlotEntry<Props> {
  readonly id: string
  readonly source?: string
  readonly order: number
  readonly component: ComponentType<Props>
}

export interface Slot<Props> extends Registry<SlotEntry<Props>> {
  readonly id: string
}

export const defineSlot = <Props extends object>(id: string): Slot<Props> => ({ id, ...makeRegistry() })

/**
 * `only`: just the entry registered under that id, for a screen focused on one section;
 * `except`: every entry but those, for a screen that shows them elsewhere.
 * `insert` places host-owned content before contributions of the same or higher order.
 */
export function SlotOutlet<Props extends object>({
  slot,
  props,
  only,
  except = [],
  insert
}: {
  slot: Slot<Props>
  props: NoInfer<Props>
  only?: string
  except?: ReadonlyArray<string>
  insert?: { order: number; element: ReactNode }
}) {
  const snapshot = useSyncExternalStore(slot.subscribe, slot.snapshot, slot.snapshot)
  const entries = snapshot.entries
    .filter((entry) => (only === undefined || entry.id === only) && !except.includes(entry.id))
    .sort((a, b) => a.order - b.order)
  const children = entries.map((entry) => (
    <OwnedBy key={`entry:${entry.id}`} registry={slot} entry={entry}>
      <entry.component {...props} />
    </OwnedBy>
  ))
  if (insert) {
    const index = entries.findIndex((entry) => entry.order >= insert.order)
    children.splice(index === -1 ? children.length : index, 0, <Fragment key="insert">{insert.element}</Fragment>)
  }
  return children
}
