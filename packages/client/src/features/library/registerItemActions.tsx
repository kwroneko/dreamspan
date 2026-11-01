// The library's own item actions. Each is a separate registration, so a plugin can replace
// or disable one (`library.chat`, `.edit`, `.archive`, `.persona`, `.update`, `.export`).
import { Link } from "@tanstack/react-router"
import { useAction } from "../../actions.tsx"
import { buttonClass } from "../../ui/Button.tsx"
import { MenuCheckboxItem, MenuGroup, MenuItem, MenuLinkItem } from "../../ui/Menu.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { downloadExport } from "./files.ts"
import { libraryItemActions, type LibraryItemProps } from "./itemActions.tsx"

const compact = "h-8! px-2.5!"

function ChatAction({ entry }: LibraryItemProps) {
  return (
    <Link
      to="/cards/$entityId/chat"
      params={{ entityId: entry.entityId }}
      aria-label={`Start a chat with ${entry.label}`}
      className={`${buttonClass("primary")} ${compact}`}
    >
      Chat
    </Link>
  )
}

function EditAction({ entry }: LibraryItemProps) {
  return (
    <Link
      to="/library/$refId"
      params={{ refId: entry.id }}
      aria-label={`Edit ${entry.label}`}
      className={`${buttonClass("secondary")} ${compact}`}
    >
      Edit
    </Link>
  )
}

function PersonaItem({ entry, persona }: LibraryItemProps) {
  const action = useAction()
  return (
    <MenuCheckboxItem
      checked={persona}
      onCheckedChange={(next) =>
        void action
          .run((client) => client("SetPersona", { entityId: entry.entityId, persona: next }), ["library"])
          .then(
            (result) =>
              !result.ok &&
              showToast({ title: "Couldn’t change the persona folder", description: result.error.message })
          )
      }
    >
      Persona
    </MenuCheckboxItem>
  )
}

function UpdateItem({ entry }: LibraryItemProps) {
  return (
    <MenuLinkItem icon="regenerate" render={<Link to="/import" search={{ into: entry.id }} />}>
      Update from file…
    </MenuLinkItem>
  )
}

/**
 * A preset's archive button, as in the preset pickers: archived, it leaves these lists for the
 * Archived view, nothing deleted; there, the same place takes it back out.
 */
function ArchiveAction({ entry }: LibraryItemProps) {
  const action = useAction()
  const archived = entry.archivedAt != null
  return (
    <IconButton
      label={`${archived ? "Unarchive" : "Archive"} ${entry.label}`}
      hint={archived ? "Unarchive: show it in the lists again" : "Archive: hide it from the lists; nothing is deleted"}
      icon={archived ? "unarchive" : "archive"}
      disabled={action.pending}
      onClick={() =>
        void action
          .run((client) => client("SetRefArchived", { refId: entry.id, archived: !archived }), ["library"])
          .then(
            (result) =>
              !result.ok &&
              showToast({
                title: archived ? `Couldn’t unarchive ${entry.label}` : `Couldn’t archive ${entry.label}`,
                description: result.error.message
              })
          )
      }
    />
  )
}

function ExportItems({ entry, exportFormats }: LibraryItemProps) {
  const formats = exportFormats.filter((format) => format.kind === entry.kind)
  const exportAs = async (format: (typeof formats)[number]["id"]) => {
    const error = await downloadExport(entry.id, format, entry.label)
    if (error) showToast({ title: `Couldn’t export ${entry.label}`, description: error })
  }
  return (
    <MenuGroup label="Export as">
      {formats.map((format) => (
        <MenuItem key={format.id} onClick={() => void exportAs(format.id)}>
          {format.label}
        </MenuItem>
      ))}
    </MenuGroup>
  )
}

export const registerItemActions = () => [
  libraryItemActions.register({
    id: "library.chat",
    order: 10,
    available: ({ entry }) => entry.kind === "card",
    direct: ChatAction
  }),
  libraryItemActions.register({
    id: "library.edit",
    order: 20,
    // Every kind's editor is its own page (`/library/$refId`).
    direct: EditAction
  }),
  libraryItemActions.register({
    id: "library.archive",
    order: 25,
    available: ({ entry }) => entry.kind === "preset" && entry.refKind !== "chat_override",
    direct: ArchiveAction
  }),
  libraryItemActions.register({
    id: "library.persona",
    order: 30,
    available: ({ entry }) => entry.kind === "card",
    menu: PersonaItem
  }),
  libraryItemActions.register({
    id: "library.update",
    order: 40,
    // A newly made fork has no import line to update from.
    available: ({ entry }) => entry.refKind === "upstream" && (entry.kind !== "card" || entry.hasImport === true),
    menu: UpdateItem
  }),
  libraryItemActions.register({
    id: "library.export",
    order: 50,
    available: ({ entry, exportFormats }) => exportFormats.some((format) => format.kind === entry.kind),
    menu: ExportItems
  })
]
