// UI slots (spec/PLUGINS.md §8): a place in a screen that renders whatever is registered
// for it, in order, so features add to a screen without the screen knowing them.
import { useSyncExternalStore, type ComponentType } from "react"
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
 */
export function SlotOutlet<Props extends object>({
  slot,
  props,
  only,
  except = []
}: {
  slot: Slot<Props>
  props: NoInfer<Props>
  only?: string
  except?: ReadonlyArray<string>
}) {
  const snapshot = useSyncExternalStore(slot.subscribe, slot.snapshot, slot.snapshot)
  return [...snapshot.entries]
    .filter((entry) => (only === undefined || entry.id === only) && !except.includes(entry.id))
    .sort((a, b) => a.order - b.order)
    .map((entry) => <entry.component key={entry.id} {...props} />)
}
