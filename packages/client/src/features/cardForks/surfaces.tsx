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
  /** An action used less: a surface with a More menu (the editor's) puts it there. */
  readonly overflow?: boolean
  readonly order: number
  readonly component: ComponentType<CardSurfaceContext>
}
export const cardContributions = makeRegistry<CardContribution>()
/** `overflow`: only the actions that go under More (true) or only the others (false); absent, all. */
export function CardSurface({
  placement,
  overflow,
  ...context
}: CardSurfaceContext & { placement: CardPlacement; overflow?: boolean }) {
  const snapshot = useSyncExternalStore(
    cardContributions.subscribe,
    cardContributions.snapshot,
    cardContributions.snapshot
  )
  return [...snapshot.entries]
    .filter((entry) => entry.placement === placement)
    .filter((entry) => overflow === undefined || (entry.overflow ?? false) === overflow)
    .sort((a, b) => a.order - b.order)
    .map((entry) => <entry.component key={entry.id} {...context} />)
}
