// Card extension points shared by library, editor and character surfaces.
import { useSyncExternalStore, type ComponentType } from "react"
import type { EntityId } from "@rp/shared/chat.ts"
import type { EditorStore } from "../editor/store.ts"
import { makeRegistry } from "../../registry.ts"

export interface CardSurfaceContext {
  readonly entityId: EntityId
  readonly store?: EditorStore
}
export type CardPlacement = "actions" | "provenance" | "badge" | "family"
interface CardContribution {
  readonly id: string
  readonly placement: CardPlacement
  readonly order: number
  readonly component: ComponentType<CardSurfaceContext>
}
export const cardContributions = makeRegistry<CardContribution>()
export function CardSurface({ placement, ...context }: CardSurfaceContext & { placement: CardPlacement }) {
  useSyncExternalStore(cardContributions.subscribe, cardContributions.snapshot, cardContributions.snapshot)
  return [...cardContributions.list()]
    .filter((entry) => entry.placement === placement)
    .sort((a, b) => a.order - b.order)
    .map((entry) => <entry.component key={entry.id} {...context} />)
}
