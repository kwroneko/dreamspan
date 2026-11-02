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
import { ChatCommandMenu, type ChatCommandDialogProps, chatCommands, shortcutText } from "./commands.tsx"

/** The pin: pins the fork shown, from its shell row (this chat's forks only). */
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
    // By id: a branch made at another's last message ends where that one does.
    .rows.find((f) => f.chat.id === view.chat?.id && f.forkId === (view.forkId ?? view.chat?.currentForkId))
  // A phone's header keeps its room for the name; the chat lists' rows have the pin too.
  return fork ? (
    <span className="contents max-sm:hidden">
      <PinButton fork={fork} />
    </span>
  ) : null
}

/** The panel's button, in a saved chat's header and in a pending one's. */
export function HeaderPanel({ view, panel }: Pick<ChatHeaderActionProps, "view" | "panel">) {
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
          .map((command) => {
            // A label that names its keys keeps them; the others get them beside. What it
            // does in detail, and where the keys work, is its description, under it.
            const keys = shortcutText(command.shortcut!)
            return (
              <li key={command.id} className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 flex-col">
                  <span>{command.label}</span>
                  {command.description && <span className="text-xs text-muted">{command.description}</span>}
                </span>
                {!command.label.includes(keys) && (
                  <kbd className="shrink-0 rounded border border-border px-1.5 font-mono text-xs text-muted">
                    {keys}
                  </kbd>
                )}
              </li>
            )
          })}
      </ul>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}
