// The chat panel host: descriptors own its tabs and bodies; the host owns layout and retention.
import type { EntityId, SlotId } from "@rp/shared/chat.ts"
import { useEffect, useState, useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { useSession } from "../../session.ts"
import { usePortraitViewer } from "../../ui/Portrait.tsx"
import { ResizeHandle, usePanelWidth } from "../../ui/ResizeHandle.tsx"
import { Sheet } from "../../ui/Sheet.tsx"
import { SubjectTabs, ToolTabs } from "../../ui/PanelTabs.tsx"
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
  onToggle,
  compact = false
}: {
  userId: string
  open: PanelTab | null
  wide: boolean
  view: ChatView
  /** Opens the panel at a tab, or closes it when that tab is the one open. */
  onToggle: (tab: PanelTab) => void
  /** One icon that opens the panel at its last tab and hides it (the chat header's). */
  compact?: boolean
}) {
  const available = usePanelTabs(view, open)
  const tabs = available.filter((tab) => tab.descriptor.header !== false)
  if (available.length === 0) return null
  const toggle = () => {
    const remembered = read(tabKey(userId))
    onToggle(
      open ??
        available.find((tab) => tab.value === remembered)?.value ??
        tabs.find((tab) => tab.descriptor.default)?.value ??
        (tabs[0] ?? available[0])!.value
    )
  }
  if (compact)
    return (
      <IconButton
        label={open === null ? "Chat panel" : "Hide panel"}
        hint={
          open === null ? "Open the chat panel: cast, settings, lorebooks, notes and summaries" : "Hide the chat panel"
        }
        icon="panel"
        aria-expanded={open !== null}
        className={open === null ? "" : "bg-surface-raised text-text"}
        onClick={toggle}
      />
    )
  if (!wide || open !== null)
    return (
      <Button
        variant="ghost"
        aria-expanded={open !== null}
        title={
          open === null ? "Open the chat panel: cast, settings, lorebooks, notes and summaries" : "Hide the chat panel"
        }
        className="h-8 px-2.5"
        onClick={toggle}
      >
        {open === null ? "Chat panel" : "Hide panel"}
      </Button>
    )
  return (
    // Icons, as ST's panel buttons are, so the header keeps room for the chat's name.
    <div role="group" aria-label="Chat panel" className="flex shrink-0 gap-0.5">
      {tabs.map((tab) => (
        <IconButton
          key={tab.value}
          label={tab.label}
          hint={tab.descriptor.description ? `${tab.label}: ${tab.descriptor.description}` : tab.label}
          icon={tab.descriptor.icon}
          onClick={() => onToggle(tab.value)}
        />
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
  onSummaries: (summary: string) => void
}) {
  // A tab mounts when first shown and stays mounted, hidden, while the panel is open, so
  // switching tabs never ends what's in one: a summary's edit with its unsaved text, say.
  const userId = useSession().user.id
  const { width, min, max, change, reset } = usePanelWidth(userId, "chat", 416, 260, wide)
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
  const all = usePanelTabs(content.view, tab)
  const tools = all.filter((t) => (t.descriptor.placement ?? "tools") === "tools")
  const cast = all.filter((t) => t.descriptor.placement === "cast")
  // While a portrait is shown, a character's chip shows theirs too: the strip's portraits switch it.
  const portraits = usePortraitViewer()
  const pick = (value: PanelTab) => {
    const avatar = cast.find((t) => t.value === value)?.avatar
    if (portraits?.shown && avatar && portraits.shown.id !== avatar.id) portraits.show(avatar)
    onTab(value)
  }
  const nav = (
    <div className="flex flex-col gap-1 border-b border-border px-2 pt-1.5">
      <ToolTabs
        tabs={tools.map((t) => ({
          value: t.value,
          label: t.label,
          icon: t.descriptor.icon,
          description: t.descriptor.description
        }))}
        value={tab}
        onValueChange={onTab}
        label="Chat panel"
        moreLabel="More tools"
        end={wide && <IconButton label="Close the panel" icon="close" className="shrink-0" onClick={onClose} />}
      />
      <SubjectTabs
        tabs={cast.map((t) => ({
          value: t.value,
          label: t.label,
          avatar: t.avatar,
          icon: t.descriptor.icon,
          note: t.note
        }))}
        value={tab}
        onValueChange={pick}
        label="Characters"
      />
      {cast.length === 0 && <div className="h-0.5" />}
    </div>
  )
  // A tab mounts when first shown and stays mounted, hidden, while the panel is open.
  const panels = all.map(
    (t) =>
      (visited.has(t.value) || t.value === tab) && (
        <div
          key={t.value}
          role="tabpanel"
          aria-label={t.label}
          hidden={t.value !== tab}
          className="@container min-h-0 flex-1 overflow-y-auto px-4 py-4 outline-none"
        >
          {/* A readable width for forms and prose, unless the tab lays itself out in columns. */}
          <div className={t.descriptor.width === "full" ? "" : "max-w-[52rem]"}>
            <PanelContent
              key={t.descriptor.id}
              descriptor={t.descriptor}
              tab={t.value}
              active={t.value === tab}
              notesFocus={notesFocus}
              onNotes={notes}
              {...content}
            />
          </div>
        </div>
      )
  )
  if (!wide)
    return (
      <Sheet open onOpenChange={(open) => !open && onClose()} title={title} closeLabel="Close">
        <div className="flex min-h-0 flex-1 flex-col">
          {nav}
          {panels}
        </div>
      </Sheet>
    )
  return (
    <aside
      aria-label="Chat panel"
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-border bg-surface"
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
      {nav}
      {panels}
    </aside>
  )
}
