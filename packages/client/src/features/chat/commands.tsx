import { kindHides } from "./kindLooks.ts"
import { chatPanels, isPanelTab, useChatPanels } from "./panels.tsx"
// Commands in the chat's ⋯ menu and on keys. The host supplies the viewed fork and navigation;
// contributions own the behavior, label, ordering and availability. A command with a
// shortcut is listed under the ⋯ menu's Keyboard shortcuts rather than in the menu itself, unless
// it asks to be in both (`menu: true`), and its keys are in its control's explanation (DESIGN
// §10.1); one with a `dialog` opens it from the menu.
import { type ComponentType, Fragment, useEffect, useState, useSyncExternalStore } from "react"
import type { BinItem } from "@dreamspan/shared/bin.ts"
import type { SlotId } from "@dreamspan/shared/chat.ts"
import type { useNavigate } from "@tanstack/react-router"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { useChatPlaceKey } from "./chatPlace.ts"
import { makeRegistry } from "../../registry.ts"
import type { IconName } from "../../ui/Icon.tsx"
import { Menu, MenuItem, MenuSeparator } from "../../ui/Menu.tsx"
import { iconButtonClass, Tooltip } from "../../ui/Tooltip.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { popupOpen } from "../../ui/openPopups.ts"
import type { ChatSession, ChatView } from "./session.ts"

export interface ChatCommandContext {
  readonly splitRootId?: string | undefined
  readonly hasSplitGroups?: boolean | undefined
  readonly session: ChatSession
  readonly view: ChatView
  readonly onHistory: () => void
  readonly onJump: (slot: SlotId) => void
  readonly saveMessageEdit?: () => void
  /** Renames the chat where its name is shown (the header's title). */
  readonly onRename?: () => void
  readonly navigate?: ReturnType<typeof useNavigate>
  /** Says something went to the bin, with Undo. */
  readonly deleted?: (item: BinItem) => void
}

export interface ChatCommandDialogProps {
  readonly context: ChatCommandContext
  readonly onClose: () => void
}

interface ChatCommand {
  readonly id: string
  readonly label: string
  /** What it does, beside its menu item while it's highlighted, so its label can stay short. */
  readonly description?: string
  readonly order: number
  readonly icon: IconName
  /** Hide the command and its shortcut while its target panel is absent or unavailable. */
  readonly panel?: string
  readonly available?: (context: ChatCommandContext) => boolean
  readonly shortcut?: { readonly key: string; readonly mod: boolean; readonly alt?: boolean }
  readonly acceptsKey?: (event: CommandKeyEvent, context: ChatCommandContext) => boolean
  /** Listed in the ⋯ menu: by default, the commands without a shortcut. */
  readonly menu?: boolean
  /** Danger tone, after a separator (Delete chat). */
  readonly tone?: "danger"
  readonly run?: (context: ChatCommandContext) => void
  /** What the menu opens instead of running it. */
  readonly dialog?: ComponentType<ChatCommandDialogProps>
  /** Restore this dialog from the tab URL. */
  readonly dialogInUrl?: boolean
}

/** A command's keys as written in its label: "Ctrl+H", "Alt+Enter", "ArrowUp". */
export const shortcutText = (shortcut: NonNullable<ChatCommand["shortcut"]>) =>
  [
    ...(shortcut.mod ? ["Ctrl"] : []),
    ...(shortcut.alt ? ["Alt"] : []),
    shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key
  ].join("+")

/** Whether the ⋯ menu lists the command. */
const inMenu = (command: ChatCommand) => command.menu ?? command.shortcut === undefined

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
        !kindHides(context.view.chat?.kind, entry.id) &&
        (entry.panel === undefined || isPanelTab(entry.panel, context.view, panels)) &&
        entry.available?.(context) !== false
    )

export function ChatCommandMenu({ context }: { context: ChatCommandContext }) {
  const snapshot = useSyncExternalStore(chatCommands.subscribe, chatCommands.snapshot, chatCommands.snapshot)
  const panels = useChatPanels()
  const [localDialog, setDialog] = useState<ChatCommand | null>(null)
  const [place, setPlace] = usePlaceParam(useChatPlaceKey("chatAction"), "")
  const commands = availableCommands(context, snapshot, panels).filter(inMenu)
  if (commands.length === 0) return null
  const dialog = commands.find((entry) => entry.dialogInUrl && entry.id === place) ?? localDialog
  const Open = dialog?.dialog
  return (
    <>
      <Menu
        label="Chat actions"
        trigger={
          <Tooltip label="Chat actions">
            <button type="button" aria-label="Chat actions" className={iconButtonClass()}>
              <Icon name="more" />
            </button>
          </Tooltip>
        }
      >
        {commands.map((entry, i) => (
          <Fragment key={entry.id}>
            {entry.tone === "danger" && i > 0 && commands[i - 1]!.tone !== "danger" && <MenuSeparator />}
            <MenuItem
              icon={entry.icon}
              tone={entry.tone ?? "default"}
              description={entry.description}
              onClick={() =>
                entry.dialog ? (entry.dialogInUrl ? setPlace(entry.id) : setDialog(entry)) : entry.run?.(context)
              }
            >
              {entry.label}
            </MenuItem>
          </Fragment>
        ))}
      </Menu>
      {Open && (
        <Open
          context={context}
          onClose={() => {
            setDialog(null)
            if (dialog?.dialogInUrl) setPlace("")
          }}
        />
      )}
    </>
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
    target?.matches('[data-testid="composer"]') === true &&
    // The chat composer's editor says it's empty (Composer.tsx); a plain composer has a value.
    (target instanceof HTMLTextAreaElement ? target.value === "" : target.hasAttribute("data-empty")) &&
    !target.hasAttribute("data-has-attachments")
  )
}

export const invokeChatCommand = (id: string, context: ChatCommandContext) => {
  const command = availableCommands(context).find((entry) => entry.id === id)
  command?.run?.(context)
}

/** Keyboard invocation resolves the same effective, available command as the menu. */
export const runCommandShortcut = (event: CommandKeyEvent, context: ChatCommandContext) => {
  // The chat composer's editor takes an arrow in its empty text as a caret move (to where it already
  // is) and prevents its default; there the key is still the empty composer's shortcut, as it was
  // in the composer's textarea.
  const caretMove = event.key.startsWith("Arrow") && emptyComposerTarget(event)
  if ((event.defaultPrevented && !caretMove) || event.isComposing || event.repeat || event.shiftKey) return false
  if (popupOpen()) return false
  const command = availableCommands(context).find(
    (entry) =>
      entry.shortcut &&
      entry.shortcut.key.toLowerCase() === event.key.toLowerCase() &&
      entry.shortcut.mod === (event.ctrlKey || event.metaKey) &&
      !!entry.shortcut.alt === !!event.altKey &&
      (entry.acceptsKey ? entry.acceptsKey(event, context) : !typingTarget(event))
  )
  if (!command?.run) return false
  command.run(context)
  return true
}

export function useChatCommandKeys(context: ChatCommandContext, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const invoke = (event: KeyboardEvent) => {
      if (runCommandShortcut(event, context)) event.preventDefault()
    }
    window.addEventListener("keydown", invoke)
    return () => window.removeEventListener("keydown", invoke)
  }, [context, enabled])
}
