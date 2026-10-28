// The chat panel host: descriptors own its tabs and bodies; the host owns layout and retention.
import type { EntityId, SlotId } from "@rp/shared/chat.ts"
import { useEffect, useState, useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { useSession } from "../../session.ts"
import { ResizeHandle, usePanelWidth } from "../../ui/ResizeHandle.tsx"
import { Sheet } from "../../ui/Sheet.tsx"
import { Tabs } from "../../ui/Tabs.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import type { ChatSession, ChatView } from "./session.ts"
import { chatPanels, isPanelTab, PanelContent, usePanelTabs } from "./panels.tsx"
export { isPanelTab } from "./panels.tsx"
/** Panel URL values are open strings, validated against the descriptors at use. */
export type PanelTab = string

// --- Whether the panel is open and at which tab: each user's choice in this browser, kept in
// its storage under keys naming the user, so another account signing in here has its own.

/** The tab open, absent while the panel is closed. */
const panelKey = (userId: string) => `rp.chatPanel.${userId}`
/** The tab last open, closed since or not: where the panel opens on a phone. */
const tabKey = (userId: string) => `rp.chatPanelTab.${userId}`

const read = (key: string): PanelTab | null => {
  try {
    const value = localStorage.getItem(key)
    return isPanelTab(value) ? value : null
  } catch {
    return null
  }
}

/** The tab open when the user last used the panel, or null when they last closed it. */
export const rememberedPanel = (userId: string) => read(panelKey(userId))

export const rememberPanel = (userId: string, tab: PanelTab | null) => {
  try {
    if (tab === null) localStorage.removeItem(panelKey(userId))
    else {
      localStorage.setItem(panelKey(userId), tab)
      localStorage.setItem(tabKey(userId), tab)
    }
  } catch {
    // Storage off: the URL still carries the tab.
  }
}

// --- Wide enough for the panel beside the chat (Tailwind's `lg`, where the sidebar shows too).

const WIDE = "(min-width: 1024px)"
const subscribeWide = (listener: () => void) => {
  const query = matchMedia(WIDE)
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}
export const useWide = () => useSyncExternalStore(subscribeWide, () => matchMedia(WIDE).matches)

/**
 * The header's buttons for the panel. On a wide screen with the panel closed, one per tab;
 * open, its own tabs take over and the header keeps one button to hide it. On a phone, one
 * button opens the sheet at the tab last used.
 */
export function PanelToggles({
  userId,
  open,
  wide,
  view,
  onToggle
}: {
  userId: string
  open: PanelTab | null
  wide: boolean
  view: ChatView
  /** Opens the panel at a tab, or closes it when that tab is the one open. */
  onToggle: (tab: PanelTab) => void
}) {
  const available = usePanelTabs(view, open)
  const tabs = available.filter((tab) => tab.descriptor.header !== false)
  if (available.length === 0) return null
  if (!wide || open !== null)
    return (
      <Button
        variant="ghost"
        aria-expanded={open !== null}
        title={
          open === null ? "Open the chat panel: cast, settings, lorebooks, notes and summaries" : "Hide the chat panel"
        }
        className="h-8 px-2.5"
        onClick={() => {
          const remembered = read(tabKey(userId))
          onToggle(
            open ??
              available.find((tab) => tab.value === remembered)?.value ??
              tabs.find((tab) => tab.descriptor.default)?.value ??
              (tabs[0] ?? available[0])!.value
          )
        }}
      >
        {open === null ? "Chat panel" : "Hide panel"}
      </Button>
    )
  return (
    // Icons, as ST's panel buttons are, so the header keeps room for the chat's name.
    <div role="group" aria-label="Chat panel" className="flex shrink-0 gap-0.5">
      {tabs.map((tab) => (
        <IconButton key={tab.value} label={tab.label} icon={tab.descriptor.icon} onClick={() => onToggle(tab.value)} />
      ))}
    </div>
  )
}

/** The panel: beside the chat on a wide screen, a sheet over it on a phone. */
export function ChatSidePanel({
  tab,
  wide,
  title,
  onTab,
  onClose,
  ...content
}: {
  tab: PanelTab
  wide: boolean
  /** The chat's title, so a phone's sheet says which chat it's about. */
  title: string
  onTab: (tab: PanelTab) => void
  onClose: () => void
  session: ChatSession
  view: ChatView
  focus: string | null
  onJump: (slot: SlotId) => void
  onEnable: () => void
}) {
  // A tab mounts when first shown and stays mounted, hidden, while the panel is open, so
  // switching tabs never ends what's in one: a summary's edit with its unsaved text, say.
  const userId = useSession().user.id
  const { ref, width, min, max, change, reset } = usePanelWidth(userId, "chat", 416, 260, 640, 426, wide)
  const [visited, setVisited] = useState<ReadonlySet<PanelTab>>(() => new Set([tab]))
  const [notesFocus, setNotesFocus] = useState<EntityId | null>(null)
  const notes = (card: EntityId) => {
    setNotesFocus(card)
    onTab("notes")
  }
  useEffect(() => {
    for (const descriptor of chatPanels.list()) descriptor.preload?.()
  }, [])
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]))
  const tabs = usePanelTabs(content.view, tab).map((t) => ({
    value: t.value,
    label: t.label,
    panel:
      visited.has(t.value) || t.value === tab ? (
        <PanelContent
          key={t.descriptor.id}
          descriptor={t.descriptor}
          tab={t.value}
          active={t.value === tab}
          notesFocus={notesFocus}
          onNotes={notes}
          {...content}
        />
      ) : null
  }))
  if (!wide)
    return (
      <Sheet open onOpenChange={(open) => !open && onClose()} title={title} closeLabel="Close">
        <Tabs tabs={tabs} value={tab} onValueChange={onTab} label="Chat panel" fill keepMounted />
      </Sheet>
    )
  return (
    <aside
      aria-label="Chat panel"
      ref={ref}
      style={{ width, minWidth: 260, maxWidth: "calc(100% - 426px)" }}
      className="relative flex min-w-0 shrink-0 flex-col border-l border-border bg-surface"
    >
      <ResizeHandle
        label="Resize chat panel"
        width={width}
        min={min}
        max={max}
        direction={-1}
        onChange={change}
        onReset={reset}
      />
      <Tabs
        tabs={tabs}
        value={tab}
        onValueChange={onTab}
        label="Chat panel"
        fill
        keepMounted
        end={
          <Button
            variant="ghost"
            aria-label="Close the panel"
            title="Close the panel"
            className="mb-1 h-8 w-8 shrink-0 px-0 text-lg leading-none"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </Button>
        }
      />
    </aside>
  )
}
