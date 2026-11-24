// Card grouping is an optional registered part, shared by both character grids. Disabling
// or replacing it changes the control and the tiles together, including in an open tab.
import { useSyncExternalStore, type ComponentType } from "react"
import { makeRegistry } from "../../registry.ts"
import type { CardBrowse } from "./cardBrowse.tsx"
import type { groupFamilies } from "./cardFamilies.ts"

export const cardGrouping = makeRegistry<{
  readonly id: string
  readonly group: typeof groupFamilies
  /** Disabled with `disabledReason` where nothing is grouped, kept in its place (no gap, no shift). */
  readonly control: ComponentType<{
    browse: CardBrowse
    onChange: (change: Partial<CardBrowse>) => void
    disabledReason?: string | undefined
  }>
}>()

export const useCardGrouping = () =>
  useSyncExternalStore(cardGrouping.subscribe, cardGrouping.snapshot, cardGrouping.snapshot).entries.at(-1)

export function CardGroupingControl({
  browse,
  onChange,
  disabledReason
}: {
  browse: CardBrowse
  onChange: (change: Partial<CardBrowse>) => void
  disabledReason?: string | undefined
}) {
  const part = useCardGrouping()
  return part ? <part.control browse={browse} onChange={onChange} disabledReason={disabledReason} /> : null
}
