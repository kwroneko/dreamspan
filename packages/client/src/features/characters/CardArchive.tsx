import type { RefId } from "@dreamspan/shared/library.ts"
import { useState } from "react"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useAction } from "../../actions.tsx"
import { MenuItem } from "../../ui/Menu.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { shellAtom } from "./shellData.tsx"
import type { CardSurfaceContext } from "../cardForks/surfaces.tsx"

function useArchiveCard(refId: RefId, name: string) {
  const action = useAction()
  const set = async (next: boolean, undo = true): Promise<boolean> => {
    const result = await action.run((client) => client("SetRefArchived", { refId, archived: next }), ["library"])
    if (!result.ok) showToast({ title: "Couldn’t change archive", description: result.error.message })
    else if (undo && result.value.changed)
      showToast({
        title: `${name} ${next ? "archived" : "unarchived"}`,
        actions: [
          {
            label: "Undo",
            hint: `Restore ${name}’s previous archive state`,
            onClick: () => {
              if (!next) return void set(true, false)
              void action
                .run(
                  (client) =>
                    client("UndoCardArchive", {
                      entityIds: [result.value.entityId],
                      archivedAt: result.value.archivedAt!
                    }),
                  ["library"]
                )
                .then((undo) => {
                  if (!undo.ok) showToast({ title: "Couldn’t undo archive", description: undo.error.message })
                })
            }
          }
        ]
      })
    return result.ok
  }
  return { pending: action.pending, set: (next: boolean) => set(next) }
}

/** What clicking does, named by the card: a hover's text, and a menu entry's. */
const archiveHint = (name: string, archived: boolean) =>
  archived
    ? `Click to unarchive ${name}: back in All and searches`
    : `Click to archive ${name}: hidden from All and searches, found under Archived`
const archiveDescription = (name: string, archived: boolean) =>
  archived
    ? `Shows ${name} in All and searches again`
    : `Hides ${name} from All and searches; find ${name} under Archived`

/**
 * A card's archive toggle, shaped like its favourite star (`FavouriteStar`): pressed while
 * archived, shown at once, and over a tile's picture styled by the tile (`className`).
 */
export function ArchiveControl({
  refId,
  name,
  archived,
  className = "",
  menu = false
}: {
  refId: RefId
  name: string
  archived: boolean
  className?: string
  menu?: boolean
}) {
  const action = useArchiveCard(refId, name)
  // Shown at once, until the shell's read says the same.
  const [shown, setShown] = useState<boolean | null>(null)
  if (shown !== null && shown === archived && !action.pending) setShown(null)
  const on = shown ?? archived
  const toggle = () => {
    setShown(!on)
    void action.set(!on).then((ok) => {
      if (!ok) setShown(null)
    })
  }
  return menu ? (
    <MenuItem icon={on ? "unarchive" : "archive"} description={archiveDescription(name, on)} onClick={toggle}>
      {on ? "Unarchive" : "Archive"}
    </MenuItem>
  ) : (
    <IconButton
      label={`${on ? "Unarchive" : "Archive"} ${name}`}
      hint={archiveHint(name, on)}
      icon={on ? "unarchive" : "archive"}
      aria-pressed={on}
      className={className}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        toggle()
      }}
    />
  )
}

function ShellArchive({ entityId, className, menu = false }: CardSurfaceContext & { menu?: boolean }) {
  const shell = useAtomValue(shellAtom)
  const card = AsyncResult.isSuccess(shell)
    ? [...shell.value.cards, ...shell.value.personas, ...shell.value.archived].find((c) => c.card.entityId === entityId)
    : undefined
  return card ? (
    <ArchiveControl
      refId={card.card.refId}
      name={card.card.label}
      archived={card.archivedAt != null}
      menu={menu}
      {...(className ? { className } : {})}
    />
  ) : null
}
export const CardArchive = (props: CardSurfaceContext) => <ShellArchive {...props} />
export const CardArchiveMenu = (props: CardSurfaceContext) => <ShellArchive {...props} menu />
