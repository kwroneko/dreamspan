import { chatPanels, isPanelTab, useChatPanels } from "./panels.tsx"
// Commands in the chat action menu. The host supplies the viewed fork and navigation;
// contributions own the behavior, label, ordering and availability.
import { useEffect, useSyncExternalStore } from "react"
import type { SlotId } from "@rp/shared/chat.ts"
import { makeRegistry } from "../../registry.ts"
import type { IconName } from "../../ui/Icon.tsx"
import { Menu, MenuItem } from "../../ui/Menu.tsx"
import type { ChatSession, ChatView } from "./session.ts"

export interface ChatCommandContext {
  readonly session: ChatSession
  readonly view: ChatView
  readonly onHistory: () => void
  readonly onJump: (slot: SlotId) => void
  readonly saveMessageEdit?: () => void
}

interface ChatCommand {
  readonly id: string
  readonly label: string
  readonly order: number
  readonly icon: IconName
  /** Hide the command and its shortcut while its target panel is absent or unavailable. */
  readonly panel?: string
  readonly available?: (context: ChatCommandContext) => boolean
  readonly shortcut?: { readonly key: string; readonly mod: boolean; readonly alt?: boolean }
  readonly acceptsKey?: (event: CommandKeyEvent, context: ChatCommandContext) => boolean
  readonly run: (context: ChatCommandContext) => void
}

export const chatCommands = makeRegistry<ChatCommand>()
export const availableCommands = (
  context: ChatCommandContext,
  snapshot = chatCommands.snapshot(),
  panels = chatPanels.snapshot()
) =>
  [...snapshot.entries]
    .sort((a, b) => a.order - b.order)
    .filter(
      (entry) =>
        (entry.panel === undefined || isPanelTab(entry.panel, context.view, panels)) &&
        entry.available?.(context) !== false
    )

export function ChatCommandMenu({ context }: { context: ChatCommandContext }) {
  const snapshot = useSyncExternalStore(chatCommands.subscribe, chatCommands.snapshot, chatCommands.snapshot)
  const panels = useChatPanels()
  const commands = availableCommands(context, snapshot, panels)
  if (commands.length === 0) return null
  return (
    <Menu
      label="Chat actions"
      trigger={
        <button
          type="button"
          aria-label="Chat actions"
          className="rounded-md px-2 py-1 text-muted hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
        >
          •••
        </button>
      }
    >
      {commands.map((entry) => (
        <MenuItem key={entry.id} icon={entry.icon} onClick={() => invokeChatCommand(entry.id, context)}>
          {entry.label}
        </MenuItem>
      ))}
    </Menu>
  )
}

export type CommandKeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey"> &
  Partial<
    Pick<
      KeyboardEvent,
      "altKey" | "shiftKey" | "isComposing" | "defaultPrevented" | "target" | "repeat" | "composedPath"
    >
  >

/** Shadow editors retarget events to their host; inspect the original focus target. */
export const keyTarget = (event: CommandKeyEvent): Element | null => {
  const target = event.composedPath?.()[0] ?? event.target
  return typeof Element !== "undefined" && target instanceof Element ? target : null
}
export const typingTarget = (event: CommandKeyEvent) =>
  keyTarget(event)?.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'
  ) !== null && keyTarget(event) !== null
export const emptyComposerTarget = (event: CommandKeyEvent) => {
  const target = keyTarget(event)
  return (
    target?.matches('textarea[data-testid="composer"]') === true &&
    (target as HTMLTextAreaElement).value === "" &&
    !target.hasAttribute("data-has-attachments")
  )
}

export const invokeChatCommand = (id: string, context: ChatCommandContext) => {
  const command = availableCommands(context).find((entry) => entry.id === id)
  command?.run(context)
}

/** Keyboard invocation resolves the same effective, available command as the menu. */
export const runCommandShortcut = (event: CommandKeyEvent, context: ChatCommandContext) => {
  if (event.defaultPrevented || event.isComposing || event.repeat || event.shiftKey) return false
  if (typeof document !== "undefined" && document.querySelector('[role="dialog"], [role="alertdialog"]')) return false
  const command = availableCommands(context).find(
    (entry) =>
      entry.shortcut &&
      entry.shortcut.key.toLowerCase() === event.key.toLowerCase() &&
      entry.shortcut.mod === (event.ctrlKey || event.metaKey) &&
      !!entry.shortcut.alt === !!event.altKey &&
      (entry.acceptsKey ? entry.acceptsKey(event, context) : !typingTarget(event))
  )
  if (!command) return false
  command.run(context)
  return true
}

export function useChatCommandKeys(context: ChatCommandContext) {
  useEffect(() => {
    const invoke = (event: KeyboardEvent) => {
      if (runCommandShortcut(event, context)) event.preventDefault()
    }
    window.addEventListener("keydown", invoke)
    return () => window.removeEventListener("keydown", invoke)
  }, [context])
}
