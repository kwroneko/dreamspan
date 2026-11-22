import { Menu } from "../../ui/Menu.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Tooltip, iconButtonClass } from "../../ui/Tooltip.tsx"
import { useEditorState } from "../editor/store.ts"
// Card extension points shared by library, editor and character surfaces.
import { useState, useSyncExternalStore, type ComponentType } from "react"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { EditorStore } from "../editor/store.ts"
import { makeRegistry } from "../../registry.ts"
import { OwnedBy } from "../../placeOwner.tsx"

export interface CardSurfaceContext {
  readonly entityId: EntityId
  /** The card's display name, where the place showing it knows it (a badge's accessible name). */
  readonly label?: string
  readonly store?: EditorStore
  /** The family section only when the card has forks: the editor's, where a lone card's is noise. */
  readonly whenForked?: boolean
  /** Classes the place gives a control it shows inline (a tile's toggle over its picture). */
  readonly className?: string
}
/** What a card's menu entry and its dialog receive: the dialog is mounted outside the menu. */
export interface CardMenuProps extends CardSurfaceContext {
  readonly openDialog: () => void
  readonly closeDialog: () => void
}
/** `header`: a row under a card's names in its header (the chat panel's tab, the full editor) and on its page. */
export type CardPlacement =
  | "archive-toggle"
  | "tile-menu"
  | "actions"
  | "provenance"
  | "badge"
  | "family"
  | "header"
  | "chats"
  | "persona-badge"
  | "persona-menu"
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
    .map((entry) =>
      entry.component ? (
        // A dialog an action keeps open in the URL closes when the action goes (placeOwner.tsx).
        <OwnedBy key={entry.id} registry={cardContributions} entry={entry}>
          <entry.component {...context} />
        </OwnedBy>
      ) : null
    )
}

/** The registered card menu actions and their dialogs, hosted beside compact-editor History. */
export function PanelCardForks({ store }: { store: EditorStore }) {
  const ref = useEditorState(store).snapshot?.ref
  const entries = cardMenuEntries(useCardContributions())
  const [open, setOpen] = useState<string | null>(null)
  if (ref?.kind !== "card") return null
  const props = (id: string) => ({
    entityId: ref.entityId,
    store,
    openDialog: () => setOpen(id),
    closeDialog: () => setOpen(null)
  })
  const selected = entries.find((entry) => entry.id === open)
  return (
    <>
      <Menu
        label="Card fork actions"
        trigger={
          <Tooltip label="Shows actions to fork this card and manage its family.">
            <button type="button" aria-label="Card fork actions" className={iconButtonClass()}>
              <Icon name="more" />
            </button>
          </Tooltip>
        }
      >
        {entries.map((entry) => (entry.menu ? <entry.menu key={entry.id} {...props(entry.id)} /> : null))}
      </Menu>
      {selected?.dialog && <selected.dialog {...props(selected.id)} />}
    </>
  )
}
