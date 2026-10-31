// Card extension points shared by library, editor and character surfaces.
import { useSyncExternalStore, type ComponentType } from "react"
import type { EntityId } from "@rp/shared/chat.ts"
import type { EditorStore } from "../editor/store.ts"
import { makeRegistry } from "../../registry.ts"

export interface CardSurfaceContext {
  readonly entityId: EntityId
  readonly store?: EditorStore
}
/** What a card's menu entry and its dialog receive: the dialog is mounted outside the menu. */
export interface CardMenuProps extends CardSurfaceContext {
  readonly openDialog: () => void
  readonly closeDialog: () => void
}
export type CardPlacement = "actions" | "provenance" | "badge" | "family"
interface CardContribution {
  readonly id: string
  readonly placement: CardPlacement
  readonly order: number
  /** Rendered where hosts show the placement inline (the card page and editor show actions as buttons). */
  readonly component?: ComponentType<CardSurfaceContext>
  /** An action's item in a card's overflow menu (the library's), a `MenuItem` or a group of them. */
  readonly menu?: ComponentType<CardMenuProps>
  /** The dialog that item opens, which the menu's host keeps mounted after the menu closes. */
  readonly dialog?: ComponentType<CardMenuProps>
}
export const cardContributions = makeRegistry<CardContribution>()
export const useCardContributions = () =>
  useSyncExternalStore(cardContributions.subscribe, cardContributions.snapshot, cardContributions.snapshot)
/** The action contributions that offer a menu item, in order. */
export const cardMenuEntries = (snapshot = cardContributions.snapshot()) =>
  [...snapshot.entries].filter((entry) => entry.placement === "actions" && entry.menu).sort((a, b) => a.order - b.order)
export function CardSurface({ placement, ...context }: CardSurfaceContext & { placement: CardPlacement }) {
  const snapshot = useCardContributions()
  return [...snapshot.entries]
    .filter((entry) => entry.placement === placement)
    .sort((a, b) => a.order - b.order)
    .map((entry) => (entry.component ? <entry.component key={entry.id} {...context} /> : null))
}
