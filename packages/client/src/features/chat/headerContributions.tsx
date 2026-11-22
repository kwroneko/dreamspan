import { composerChoice } from "./speaker.ts"
// The chat header's built-in parts, each a registration a plugin can override or disable:
// its buttons (the pin, ⋯, the side panel) in `chatHeaderActions`, and the chat-level commands of
// its ⋯ menu in `chatCommands` (Rename, Branches…, New chat with this cast, Export, Delete
// chat; Keyboard shortcuts lists the commands that have keys). What they render loads with
// the chat (headerParts.tsx, chatExport.tsx), not with the app.
import { type ComponentType, lazy, Suspense } from "react"
import { CenterHeaderEnd } from "../../ui/CenterHeader.tsx"
import { showToast } from "../../ui/Toast.tsx"
import type { ChatHeaderActionProps, PendingHeaderActionProps } from "./ChatHeader.tsx"
import { castCharacters } from "./chatTitle.ts"
import { type ChatCommandDialogProps, chatCommands } from "./commands.tsx"
import { requestBranches } from "./forks.ts"
import { mergesInto } from "./kindLooks.ts"
import { chatHeaderActions, pendingChatHeaderActions } from "./presentation.tsx"

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
const PendingPanel = deferred<PendingHeaderActionProps>(() =>
  import("./headerParts.tsx").then((m) => ({ default: m.HeaderPanel }))
)
const ShortcutsDialog = deferred<ChatCommandDialogProps>(() =>
  import("./headerParts.tsx").then((m) => ({ default: m.ShortcutsDialog }))
)
const ExportChatDialog = deferred<ChatCommandDialogProps>(() =>
  import("./chatExport.tsx").then((m) => ({ default: m.ExportChatDialog }))
)

const DeleteChatGroupDialog = deferred<ChatCommandDialogProps>(() =>
  import("./DeleteChatGroupDialog.tsx").then((m) => ({ default: m.DeleteChatGroupDialog }))
)
const MergeChatCommandDialog = deferred<ChatCommandDialogProps>(() =>
  import("./MergeChatDialog.tsx").then((m) => ({ default: m.MergeChatCommandDialog }))
)
const SplitChatCommandDialog = deferred<ChatCommandDialogProps>(() =>
  import("./SplitChatDialog.tsx").then((m) => ({ default: m.SplitChatCommandDialog }))
)

export const registerChatHeader = () => [
  chatHeaderActions.register({ id: "chat.pin", order: 10, component: part("HeaderPin") }),
  chatHeaderActions.register({ id: "chat.menu", order: 20, component: part("HeaderMenu") }),
  // The center header's own end controls (the split buttons) sit before the panel toggle,
  // which stays at the edge beside the panel.
  chatHeaderActions.register({ id: "chat.header-end", order: 25, component: CenterHeaderEnd }),
  chatHeaderActions.register({ id: "chat.panel", order: 30, component: part("HeaderPanel") }),
  // A chat not made yet has no pin (no branch to pin) and no ⋯ (its commands need a saved chat).
  pendingChatHeaderActions.register({ id: "chat.header-end", order: 15, component: CenterHeaderEnd }),
  pendingChatHeaderActions.register({ id: "chat.panel", order: 20, component: PendingPanel }),
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
    id: "chat.split",
    // Its new chat's name is typed text: a reload opens the dialog again (editor/durable.tsx).
    dialogInUrl: true,
    label: "Make this branch its own chat",
    description: "Moves this branch and the branches made from it into a chat of their own.",
    order: 2.5,
    icon: "branch",
    available: ({ view, splitRootId }) =>
      splitRootId !== undefined && (view.forkId ?? view.chat?.currentForkId) !== splitRootId,
    dialog: SplitChatCommandDialog
  }),
  chatCommands.register({
    id: "chat.merge",
    dialogInUrl: true,
    label: "Merge another chat…",
    description: "Brings another chat's messages into this one, after the newest message.",
    order: 2.6,
    icon: "merge",
    available: ({ view }) => view.chat !== null && view.entries.length > 0 && mergesInto(view.chat),
    dialog: MergeChatCommandDialog
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
      const search = { guidance: composerChoice(session).snapshot().guidance ? "on" : "off" }
      // One character: a new chat with its card; several: with the group, every member greeting.
      if (cast.length === 1)
        void navigate?.({ to: "/cards/$entityId/chat", params: { entityId: cast[0]!.entityId }, search })
      else void navigate?.({ to: "/groups/$chatId/new", params: { chatId: session.id }, search })
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
  chatCommands.register({
    id: "chat.delete-group",
    label: "Delete chat",
    description: "Moves this chat's branches to the bin, from which they can be restored later.",
    order: 90,
    icon: "trash",
    tone: "danger",
    available: ({ view, hasSplitGroups }) => view.chat !== null && hasSplitGroups === true,
    dialog: DeleteChatGroupDialog
  }),
  // Chats without split groups keep the existing immediate delete.
  chatCommands.register({
    id: "chat.delete",
    label: "Delete chat",
    description: "Moves this chat and all its branches to the bin, from which it can be restored later.",
    order: 90,
    icon: "trash",
    tone: "danger",
    available: ({ view, deleted, hasSplitGroups }) =>
      view.chat !== null && deleted !== undefined && hasSplitGroups === false,
    run: ({ session, deleted }) =>
      void session
        .call((client) => client("DeleteChat", { chatId: session.id }))
        .then((result) => {
          if (result.ok) deleted?.(result.value)
          else showToast({ title: "Couldn't delete the chat", description: result.error.message })
        })
  })
]
