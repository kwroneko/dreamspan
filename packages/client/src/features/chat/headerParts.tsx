// The chat header's built-in buttons and dialogs (headerContributions.tsx registers them),
// loaded with the chat rather than with the app.
import { useNavigate } from "@tanstack/react-router"
import { useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import type { ChatHeaderActionProps } from "./ChatHeader.tsx"
import { PinButton } from "../characters/ShellBrowser.tsx"
import { useShellForks } from "../characters/shellData.tsx"
import { PanelToggles } from "./ChatPanels.tsx"
import { ChatCommandMenu, type ChatCommandDialogProps, chatCommands } from "./commands.tsx"

/** ☆: pins the fork shown, from its shell row (this chat's forks only). */
export function HeaderPin({ view }: ChatHeaderActionProps) {
  const fork = useShellForks({
    entity: null,
    chat: view.chat?.id ?? null,
    chats: view.chat ? [view.chat.id] : [],
    search: "",
    sort: "recent",
    sections: [{ id: "all", limit: 1000 }]
  })
    .section("all")
    .rows.find((f) => f.chat.id === view.chat?.id && f.leaf === view.leafSlotId)
  // A phone's header keeps its room for the name; the chat lists' rows have ☆ too.
  return fork ? (
    <span className="contents max-sm:hidden">
      <PinButton fork={fork} />
    </span>
  ) : null
}

export function HeaderPanel({ view, panel }: ChatHeaderActionProps) {
  return (
    <PanelToggles
      compact
      view={view}
      userId={panel.userId}
      open={panel.open}
      wide={panel.wide}
      onToggle={panel.onToggle}
    />
  )
}

export function HeaderMenu({ session, view, onHistory, onJump, onRename }: ChatHeaderActionProps) {
  const navigate = useNavigate()
  const deleted = useDeletedToast()
  return <ChatCommandMenu context={{ session, view, onHistory, onJump, onRename, navigate, deleted }} />
}

/** Every command with a key, from the registry, so a plugin's keys are listed too. */
export function ShortcutsDialog({ onClose }: ChatCommandDialogProps) {
  const snapshot = useSyncExternalStore(chatCommands.subscribe, chatCommands.snapshot, chatCommands.snapshot)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title="Keyboard shortcuts">
      <ul className="flex flex-col gap-1.5 text-sm">
        {[...snapshot.entries]
          .filter((command) => command.shortcut)
          .sort((a, b) => a.order - b.order)
          .map((command) => (
            <li key={command.id}>{command.label}</li>
          ))}
      </ul>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}
