// Card extension points shared by library, editor and character surfaces.
import { useSyncExternalStore, type ComponentType } from "react"
import type { EntityId } from "@rp/shared/chat.ts"
import type { EditorStore } from "../editor/store.ts"
import { makeRegistry } from "../../registry.ts"

export interface CardSurfaceContext {
  readonly entityId: EntityId
  /** The card's display name, where the place showing it knows it (a badge's accessible name). */
  readonly label?: string
  readonly store?: EditorStore
  /** The family section only when the card has forks: the editor's, where a lone card's is noise. */
  readonly whenForked?: boolean
}
/** What a card's menu entry and its dialog receive: the dialog is mounted outside the menu. */
export interface CardMenuProps extends CardSurfaceContext {
  readonly openDialog: () => void
  readonly closeDialog: () => void
}
/** `header`: a row under a card's names in its header (the chat panel's tab, the full editor) and on its page. */
export type CardPlacement = "actions" | "provenance" | "badge" | "family" | "header" | "chats"
interface CardContribution {
  readonly id: string
  readonly placement: CardPlacement
  /** An action used less: a surface with a More menu (the editor's) puts it there. */
  readonly overflow?: boolean
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
/** `overflow`: only the actions that go under More (true) or only the others (false); absent, all. */
export function CardSurface({
  placement,
  overflow,
  ...context
}: CardSurfaceContext & { placement: CardPlacement; overflow?: boolean }) {
  const snapshot = useCardContributions()
  return [...snapshot.entries]
    .filter((entry) => entry.placement === placement)
    .filter((entry) => overflow === undefined || (entry.overflow ?? false) === overflow)
    .sort((a, b) => a.order - b.order)
    .map((entry) => (entry.component ? <entry.component key={entry.id} {...context} /> : null))
}
