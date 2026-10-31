// The library's own item actions. Each is a separate registration, so a plugin can replace
// or disable one (`library.chat`, `.edit`, `.persona`, `.update`, `.export`).
import { Link } from "@tanstack/react-router"
import { useAction } from "../../actions.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { MenuCheckboxItem, MenuGroup, MenuItem, MenuLinkItem } from "../../ui/Menu.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
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
  const workspace = usePresetWorkspace()
  return entry.kind === "preset" ? (
    <Button aria-label={`Edit ${entry.label}`} className={compact} onClick={() => workspace?.open(entry.id)}>
      Edit
    </Button>
  ) : (
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
    available: ({ entry }) => entry.kind !== "lorebook",
    direct: EditAction
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
