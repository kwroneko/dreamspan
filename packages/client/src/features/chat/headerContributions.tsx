// The chat header's built-in parts, each a registration a plugin can override or disable:
// its buttons (☆, the side panel, ⋯) in `chatHeaderActions`, and the chat-level commands of
// its ⋯ menu in `chatCommands` (Rename, Branches…, New chat with this cast, Export, Delete
// chat; Keyboard shortcuts lists the commands that have keys). What they render loads with
// the chat (headerParts.tsx, chatExport.tsx), not with the app.
import { type ComponentType, lazy, Suspense } from "react"
import { showToast } from "../../ui/Toast.tsx"
import type { ChatHeaderActionProps } from "./ChatHeader.tsx"
import { castCharacters } from "./chatTitle.ts"
import { type ChatCommandDialogProps, chatCommands } from "./commands.tsx"
import { requestBranches } from "./forks.ts"
import { chatHeaderActions } from "./presentation.tsx"

function deferred<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  const Component = lazy(load)
  return (props: P) => (
    <Suspense fallback={null}>
      <Component {...props} />
    </Suspense>
  )
}
const part = <K extends "HeaderPin" | "HeaderPanel" | "HeaderMenu">(name: K) =>
  deferred<ChatHeaderActionProps>(() => import("./headerParts.tsx").then((m) => ({ default: m[name] })))
const ShortcutsDialog = deferred<ChatCommandDialogProps>(() =>
  import("./headerParts.tsx").then((m) => ({ default: m.ShortcutsDialog }))
)
const ExportChatDialog = deferred<ChatCommandDialogProps>(() =>
  import("./chatExport.tsx").then((m) => ({ default: m.ExportChatDialog }))
)

export const registerChatHeader = () => [
  chatHeaderActions.register({ id: "chat.pin", order: 10, component: part("HeaderPin") }),
  chatHeaderActions.register({ id: "chat.panel", order: 20, component: part("HeaderPanel") }),
  chatHeaderActions.register({ id: "chat.menu", order: 30, component: part("HeaderMenu") }),
  chatCommands.register({
    id: "chat.rename",
    label: "Rename",
    order: 1,
    icon: "edit",
    available: ({ view, onRename }) => view.chat !== null && onRename !== undefined,
    run: ({ onRename }) => onRename?.()
  }),
  chatCommands.register({
    id: "chat.branches",
    label: "Branches…",
    description: "Switch to, rename or delete this chat's branches.",
    order: 2,
    icon: "branch",
    available: ({ view }) => view.chat !== null,
    run: ({ session }) => requestBranches(session.id)
  }),
  chatCommands.register({
    id: "chat.new-with-cast",
    label: "New chat with this cast",
    description: "A fresh chat with the same characters, each greeting again. It's saved when you first send.",
    order: 3,
    icon: "plus",
    available: ({ view, navigate }) => navigate !== undefined && castCharacters(view).length > 0,
    run: ({ session, view, navigate }) => {
      const cast = castCharacters(view)
      // One character: a new chat with its card; several: with the group, every member greeting.
      if (cast.length === 1) void navigate?.({ to: "/cards/$entityId/chat", params: { entityId: cast[0]!.entityId } })
      else void navigate?.({ to: "/groups/$chatId/new", params: { chatId: session.id } })
    }
  }),
  chatCommands.register({
    id: "chat.export",
    label: "Export…",
    description: "Downloads the branch shown as a SillyTavern chat file or plain text.",
    order: 4,
    icon: "download",
    available: ({ view }) => view.chat !== null,
    dialog: ExportChatDialog
  }),
  chatCommands.register({
    id: "chat.shortcuts",
    label: "Keyboard shortcuts",
    order: 80,
    icon: "keyboard",
    dialog: ShortcutsDialog
  }),
  // To the bin, with Undo, as every delete (DESIGN §6.2): no confirmation.
  chatCommands.register({
    id: "chat.delete",
    label: "Delete chat",
    description: "Moves the chat, with all its branches, to the bin, with Undo.",
    order: 90,
    icon: "trash",
    tone: "danger",
    available: ({ view, deleted }) => view.chat !== null && deleted !== undefined,
    run: ({ session, deleted }) =>
      void session
        .call((client) => client("DeleteChat", { chatId: session.id }))
        .then((result) => {
          if (result.ok) deleted?.(result.value)
          else showToast({ title: "Couldn't delete the chat", description: result.error.message })
        })
  })
]
