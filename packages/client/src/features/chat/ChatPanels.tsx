// The chat's side panel (DESIGN §10.1): who's here, what the chat sends with, its lorebooks,
// notes and summaries, beside the messages as ST's panels are, so the chat stays readable and
// usable while it's open. On a phone it's a sheet over the chat. The open tab is in the URL
// (`?panel=`), and this browser remembers it, for each user, for the next chat opened on a
// wide screen.
import { CharacterPanel } from "../characters/CharacterPanel.tsx"
import type { EntityId } from "@rp/shared/chat.ts"
import type { SlotId } from "@rp/shared/chat.ts"
import { Component, lazy, type ReactNode, Suspense, useEffect, useState, useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { useSession } from "../../session.ts"
import { PortraitView } from "../../ui/Portrait.tsx"
import { ResizeHandle, usePanelWidth } from "../../ui/ResizeHandle.tsx"
import { Sheet } from "../../ui/Sheet.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { Tabs } from "../../ui/Tabs.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { CastTab } from "./CastTab.tsx"
import { LorebooksTab } from "./LorebooksTab.tsx"
import type { ChatSession, ChatView } from "./session.ts"
import { SummaryPanel } from "./SummaryPanel.tsx"
import { ThisChatTab } from "./ThisChatTab.tsx"

// Loaded with the panel, not with the chat: it carries the note editor. Fetched as the panel
// opens, so a tab first shown while the server can't be reached still has it.
const loadNotes = () => import("./ChatNotes.tsx").then((module) => ({ default: module.NotesTab }))
let NotesTab = lazy(loadNotes)

/** A tab's code that couldn't be fetched says so in the tab, the chat and other tabs unharmed. */
class NotLoaded extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm text-danger">
          The notes couldn't be loaded: the server can't be reached.
        </p>
        <Button
          onClick={() => {
            NotesTab = lazy(loadNotes)
            this.setState({ failed: false })
          }}
        >
          Try again
        </Button>
      </div>
    )
  }
}

const PANEL_TABS = [
  { value: "portrait", label: "Portrait", icon: "people" },
  { value: "cast", label: "Cast", icon: "people" },
  { value: "chat", label: "This chat", icon: "sliders" },
  { value: "lorebooks", label: "Lorebooks", icon: "book" },
  { value: "notes", label: "Notes", icon: "note" },
  { value: "summaries", label: "Summaries", icon: "summary" }
] as const

export type PanelTab = (typeof PANEL_TABS)[number]["value"] | `card:${string}`

export const isPanelTab = (value: unknown): value is PanelTab =>
  (typeof value === "string" && /^card:[0-9a-f-]{36}$/.test(value)) || PANEL_TABS.some((tab) => tab.value === value)

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
  onToggle
}: {
  userId: string
  open: PanelTab | null
  wide: boolean
  /** Opens the panel at a tab, or closes it when that tab is the one open. */
  onToggle: (tab: PanelTab) => void
}) {
  if (!wide || open !== null)
    return (
      <Button
        variant="ghost"
        aria-expanded={open !== null}
        title={
          open === null ? "Open the chat panel: cast, settings, lorebooks, notes and summaries" : "Hide the chat panel"
        }
        className="h-8 px-2.5"
        onClick={() => onToggle(open ?? read(tabKey(userId)) ?? "chat")}
      >
        {open === null ? "Chat panel" : "Hide panel"}
      </Button>
    )
  return (
    // Icons, as ST's panel buttons are, so the header keeps room for the chat's name.
    <div role="group" aria-label="Chat panel" className="flex shrink-0 gap-0.5">
      {PANEL_TABS.map((tab) => (
        <IconButton key={tab.value} label={tab.label} icon={tab.icon} onClick={() => onToggle(tab.value)} />
      ))}
    </div>
  )
}

function TabContent({
  tab,
  active,
  session,
  view,
  focus,
  onJump,
  onEnable
}: {
  tab: PanelTab
  /** The tab shown: one kept mounted while another is reads its lists again when shown. */
  active: boolean
  session: ChatSession
  view: ChatView
  focus: string | null
  onJump: (slot: SlotId) => void
  onEnable: () => void
}) {
  if (tab.startsWith("card:")) return <CharacterPanel entityId={tab.slice(5) as EntityId} />
  switch (tab) {
    case "portrait":
      return <PortraitView />
    case "cast":
      return <CastTab session={session} />
    case "chat":
      return <ThisChatTab session={session} active={active} />
    case "lorebooks":
      return <LorebooksTab session={session} active={active} />
    case "notes":
      return (
        <NotLoaded>
          <Suspense fallback={<Loading label="Loading the notes…" />}>
            <NotesTab session={session} leafSlotId={view.leafSlotId} />
          </Suspense>
        </NotLoaded>
      )
    case "summaries":
      return view.lcm === null ? (
        <Loading label="Loading the summaries…" />
      ) : (
        <SummaryPanel session={session} lcm={view.lcm} focus={focus} onJump={onJump} onEnable={onEnable} />
      )
  }
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
  useEffect(() => {
    void loadNotes().catch(() => undefined)
  }, [])
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]))
  const characterTabs = (content.view.cast?.cards ?? []).map((c) => ({
    value: `card:${c.entityId}` as PanelTab,
    label: c.label
  }))
  if (tab.startsWith("card:") && !characterTabs.some((t) => t.value === tab))
    characterTabs.push({ value: tab, label: "Character" })
  const tabs = [...PANEL_TABS, ...characterTabs].map((t) => ({
    value: t.value,
    label: t.label,
    panel:
      visited.has(t.value) || t.value === tab ? (
        <TabContent tab={t.value} active={t.value === tab} {...content} />
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
