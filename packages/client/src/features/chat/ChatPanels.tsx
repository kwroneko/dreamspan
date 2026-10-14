// The chat's side panel (DESIGN §10.1): who's here, what the chat sends with, its lorebooks,
// notes and summaries, beside the messages as ST's panels are, so the chat stays readable and
// usable while it's open. On a phone it's a sheet over the chat. The open tab is in the URL
// (`?panel=`), and this browser remembers it for the next chat opened on a wide screen.
import type { SlotId } from "@rp/shared/chat.ts"
import { lazy, Suspense, useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { Sheet } from "../../ui/Sheet.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { Tabs } from "../../ui/Tabs.tsx"
import { CastTab } from "./CastTab.tsx"
import { LorebooksTab } from "./LorebooksTab.tsx"
import type { ChatSession, ChatView } from "./session.ts"
import { SummaryPanel } from "./SummaryPanel.tsx"
import { ThisChatTab } from "./ThisChatTab.tsx"

// Loaded when first opened: it carries the note editor.
const NotesTab = lazy(() => import("./ChatNotes.tsx").then((module) => ({ default: module.NotesTab })))

const PANEL_TABS = [
  { value: "cast", label: "Cast" },
  { value: "chat", label: "This chat" },
  { value: "lorebooks", label: "Lorebooks" },
  { value: "notes", label: "Notes" },
  { value: "summaries", label: "Summaries" }
] as const

export type PanelTab = (typeof PANEL_TABS)[number]["value"]

export const isPanelTab = (value: unknown): value is PanelTab => PANEL_TABS.some((tab) => tab.value === value)

// --- Whether the panel is open and at which tab: a choice of this browser, kept in its storage.

/** The tab open, absent while the panel is closed. */
const PANEL_KEY = "rp.chatPanel"
/** The tab last open, closed since or not: where the panel opens on a phone. */
const TAB_KEY = "rp.chatPanelTab"

const read = (key: string): PanelTab | null => {
  try {
    const value = localStorage.getItem(key)
    return isPanelTab(value) ? value : null
  } catch {
    return null
  }
}

/** The tab open when the panel was last used, or null when it was last closed. */
export const rememberedPanel = () => read(PANEL_KEY)

export const rememberPanel = (tab: PanelTab | null) => {
  try {
    if (tab === null) localStorage.removeItem(PANEL_KEY)
    else {
      localStorage.setItem(PANEL_KEY, tab)
      localStorage.setItem(TAB_KEY, tab)
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
  open,
  wide,
  onToggle
}: {
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
        onClick={() => onToggle(open ?? read(TAB_KEY) ?? "chat")}
      >
        {open === null ? "Chat panel" : "Hide panel"}
      </Button>
    )
  return (
    <div role="group" aria-label="Chat panel" className="flex flex-wrap gap-0.5">
      {PANEL_TABS.map((tab) => (
        <Button
          key={tab.value}
          variant="ghost"
          title={`Open ${tab.label} in the side panel`}
          className="h-8 px-2.5"
          onClick={() => onToggle(tab.value)}
        >
          {tab.label}
        </Button>
      ))}
    </div>
  )
}

function TabContent({
  tab,
  session,
  view,
  focus,
  onJump,
  onEnable
}: {
  tab: PanelTab
  session: ChatSession
  view: ChatView
  focus: string | null
  onJump: (slot: SlotId) => void
  onEnable: () => void
}) {
  switch (tab) {
    case "cast":
      return <CastTab session={session} />
    case "chat":
      return <ThisChatTab session={session} />
    case "lorebooks":
      return <LorebooksTab session={session} />
    case "notes":
      return (
        <Suspense fallback={<Loading label="Loading the notes…" />}>
          <NotesTab session={session} leafSlotId={view.leafSlotId} />
        </Suspense>
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
  const tabs = PANEL_TABS.map((t) => ({
    value: t.value,
    label: t.label,
    panel: t.value === tab ? <TabContent tab={tab} {...content} /> : null
  }))
  if (!wide)
    return (
      <Sheet open onOpenChange={(open) => !open && onClose()} title={title} closeLabel="Close">
        <Tabs tabs={tabs} value={tab} onValueChange={onTab} label="Chat panel" fill />
      </Sheet>
    )
  return (
    <aside
      aria-label="Chat panel"
      className="flex w-[22.5rem] shrink-0 flex-col border-l border-border bg-surface xl:w-[26rem]"
    >
      <Tabs
        tabs={tabs}
        value={tab}
        onValueChange={onTab}
        label="Chat panel"
        fill
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
