// What a library item offers: a direct action or two beside it and an overflow menu for the
// rest, each a registered entry a plugin can replace, disable or add to. A card's menu also
// lists the card contributions' menu items (fork, forks, compare, mark as a fork of…).
import type { LibraryRef } from "@rp/shared/library.ts"
import type { ExportFormatInfo } from "@rp/shared/libraryImport.ts"
import { useState, useSyncExternalStore, type ComponentType } from "react"
import { makeRegistry } from "../../registry.ts"
import { Icon } from "../../ui/Icon.tsx"
import { Menu, MenuSeparator } from "../../ui/Menu.tsx"
import { iconButtonClass, Tooltip } from "../../ui/Tooltip.tsx"
import { cardMenuEntries, useCardContributions } from "../cardForks/surfaces.tsx"

export interface LibraryItemContext {
  readonly entry: LibraryRef
  /** A card in the persona folder (DESIGN §2.2). */
  readonly persona: boolean
  /** The formats this entry's kind exports to, in preference order. */
  readonly exportFormats: ReadonlyArray<ExportFormatInfo>
}
export interface LibraryItemProps extends LibraryItemContext {
  readonly openDialog: () => void
  readonly closeDialog: () => void
}
export interface LibraryItemAction {
  readonly id: string
  readonly order: number
  readonly available?: (context: LibraryItemContext) => boolean
  /** Always shown beside the item. The built-ins keep this to two: open a chat, and edit. */
  readonly direct?: ComponentType<LibraryItemProps>
  /** Its entry in the item's overflow menu: a `MenuItem`, or a group of them. */
  readonly menu?: ComponentType<LibraryItemProps>
  /** The dialog its menu entry opens, kept mounted by the host after the menu closes. */
  readonly dialog?: ComponentType<LibraryItemProps>
}
export const libraryItemActions = makeRegistry<LibraryItemAction>()

export const availableItemActions = (context: LibraryItemContext, snapshot = libraryItemActions.snapshot()) =>
  [...snapshot.entries].sort((a, b) => a.order - b.order).filter((action) => action.available?.(context) !== false)

/** "Aria Vance · v2", what tells two items with one name apart. */
export const itemName = (entry: LibraryRef) => (entry.subtitle ? `${entry.label} · ${entry.subtitle}` : entry.label)

type Open = { readonly from: "library" | "card"; readonly id: string }

export function LibraryItemActions({ context }: { context: LibraryItemContext }) {
  const snapshot = useSyncExternalStore(
    libraryItemActions.subscribe,
    libraryItemActions.snapshot,
    libraryItemActions.snapshot
  )
  const cards = useCardContributions()
  const actions = availableItemActions(context, snapshot)
  const cardEntries = context.entry.kind === "card" ? cardMenuEntries(cards) : []
  const menu = actions.filter((action) => action.menu)
  const [open, setOpen] = useState<Open | null>(null)
  const props = (target: Open) => ({
    openDialog: () => setOpen(target),
    closeDialog: () => setOpen(null)
  })
  // A dialog whose action was removed or disabled goes with it.
  const libraryDialog = open?.from === "library" ? actions.find((action) => action.id === open.id) : undefined
  const cardDialog = open?.from === "card" ? cardEntries.find((entry) => entry.id === open.id) : undefined
  const label = `More actions for ${itemName(context.entry)}`
  return (
    <div className="flex shrink-0 items-center gap-1">
      {actions.map((action) =>
        action.direct ? (
          <action.direct key={action.id} {...context} {...props({ from: "library", id: action.id })} />
        ) : null
      )}
      {(menu.length > 0 || cardEntries.length > 0) && (
        <Menu
          label={label}
          trigger={
            <Tooltip label="More actions">
              <button type="button" aria-label={label} className={iconButtonClass()}>
                <Icon name="more" />
              </button>
            </Tooltip>
          }
        >
          {menu.map((action) =>
            action.menu ? (
              <action.menu key={action.id} {...context} {...props({ from: "library", id: action.id })} />
            ) : null
          )}
          {menu.length > 0 && cardEntries.length > 0 && <MenuSeparator />}
          {cardEntries.map((entry) =>
            entry.menu ? (
              <entry.menu key={entry.id} entityId={context.entry.entityId} {...props({ from: "card", id: entry.id })} />
            ) : null
          )}
        </Menu>
      )}
      {open && libraryDialog?.dialog && <libraryDialog.dialog {...context} {...props(open)} />}
      {open && cardDialog?.dialog && <cardDialog.dialog entityId={context.entry.entityId} {...props(open)} />}
    </div>
  )
}
