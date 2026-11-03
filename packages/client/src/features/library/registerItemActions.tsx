// The library's own item actions. Each is a separate registration, so a plugin can replace
// or disable one (`library.chat`, `.edit`, `.archive`, `.persona`, `.update`, `.export`).
import { Link } from "@tanstack/react-router"
import { useAction } from "../../actions.tsx"
import { buttonClass } from "../../ui/Button.tsx"
import { MenuCheckboxItem, MenuGroup, MenuItem, MenuLinkItem } from "../../ui/Menu.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { requestExport } from "../cardExport/exportRequests.ts"
import { PERSONA_FOLDER_HINT, useSetPersona } from "../characters/personaFolder.tsx"
import { libraryItemActions, type LibraryItemProps } from "./itemActions.tsx"

const compact = "h-8! px-2.5!"

function ChatAction({ entry, description }: LibraryItemProps) {
  const link = (
    <Link
      to="/cards/$entityId/chat"
      params={{ entityId: entry.entityId }}
      aria-label={`Start a chat with ${entry.label}`}
      className={`${buttonClass("primary")} ${compact}`}
    >
      Chat
    </Link>
  )
  return description ? <Tooltip label={description}>{link}</Tooltip> : link
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

/** The same action as the Persona switch in a card's header (`personaFolder.tsx`). */
function PersonaItem({ entry, persona, description }: LibraryItemProps) {
  const { set } = useSetPersona()
  return (
    <MenuCheckboxItem
      checked={persona}
      description={description}
      onCheckedChange={(next) => void set(entry.entityId, next)}
    >
      Persona
    </MenuCheckboxItem>
  )
}

function UpdateItem({ entry, description }: LibraryItemProps) {
  return (
    <MenuLinkItem
      icon="regenerate"
      description={description}
      render={<Link to="/import" search={{ into: entry.id }} />}
    >
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
  // The last saved revision; with unsaved changes it asks first (cardExport's check).
  return (
    <MenuGroup label="Export as">
      {formats.map((format) => (
        <MenuItem
          key={format.id}
          description={format.description}
          onClick={() =>
            requestExport({ refId: entry.id, format: format.id, formatLabel: format.label, label: entry.label })
          }
        >
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
    direct: ChatAction,
    description: "Opens a new chat with them at their greeting. Nothing is saved until you send."
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
    menu: PersonaItem,
    description: PERSONA_FOLDER_HINT
  }),
  libraryItemActions.register({
    id: "library.update",
    order: 40,
    // Presets and lorebooks merge a new version of their file; a card takes one wholesale
    // through "Import a new version…" (features/cardImport), until cards have a merge too.
    available: ({ entry }) => entry.refKind === "upstream" && entry.kind !== "card",
    menu: UpdateItem,
    description: "Imports a new version of its file, merged with your own edits."
  }),
  libraryItemActions.register({
    id: "library.export",
    order: 50,
    available: ({ entry, exportFormats }) => exportFormats.some((format) => format.kind === entry.kind),
    menu: ExportItems
  })
]
