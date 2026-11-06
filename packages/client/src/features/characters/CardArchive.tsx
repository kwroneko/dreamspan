import type { RefId } from "@rp/shared/library.ts"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useAction } from "../../actions.tsx"
import { MenuItem } from "../../ui/Menu.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { shellAtom } from "./shellData.tsx"
import type { CardSurfaceContext } from "../cardForks/surfaces.tsx"

function useArchiveCard(refId: RefId, name: string, archived: boolean) {
  const action = useAction()
  const set = async (next: boolean, undo = true) => {
    const result = await action.run((client) => client("SetRefArchived", { refId, archived: next }), ["library"])
    if (!result.ok) showToast({ title: "Couldn’t change archive", description: result.error.message })
    else if (undo)
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
  }
  return { pending: action.pending, toggle: () => void set(!archived) }
}

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
  const action = useArchiveCard(refId, name, archived)
  const label = `${archived ? "Unarchive" : "Archive"} ${name}`
  const hint = archived
    ? "Click to unarchive this card: show in the lists again"
    : "Click to archive this card: hide from the lists"
  return menu ? (
    <MenuItem
      icon={archived ? "unarchive" : "archive"}
      description={hint}
      disabled={action.pending}
      onClick={action.toggle}
    >
      {archived ? "Unarchive" : "Archive"}
    </MenuItem>
  ) : (
    <IconButton
      label={label}
      hint={hint}
      icon={archived ? "unarchive" : "archive"}
      disabled={action.pending}
      onClick={action.toggle}
      className={className}
    />
  )
}

function ShellArchive({ entityId, menu = false }: CardSurfaceContext & { menu?: boolean }) {
  const shell = useAtomValue(shellAtom)
  const card = AsyncResult.isSuccess(shell)
    ? [...shell.value.cards, ...shell.value.personas, ...shell.value.archived].find((c) => c.card.entityId === entityId)
    : undefined
  return card ? (
    <ArchiveControl refId={card.card.refId} name={card.card.label} archived={card.archivedAt != null} menu={menu} />
  ) : null
}
export const CardArchive = (props: CardSurfaceContext) => <ShellArchive {...props} />
export const CardArchiveMenu = (props: CardSurfaceContext) => <ShellArchive {...props} menu />
