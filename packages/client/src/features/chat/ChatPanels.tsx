import { usePlaceParam, usePlaceNotice } from "../../usePlaceParam.ts"
// The chat panel host: descriptors own its tabs and bodies; the host owns layout and retention.
import type { EntityId, SlotId } from "@rp/shared/chat.ts"
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router"
import { Button } from "../../ui/Button.tsx"
import { useSession } from "../../session.ts"
import { usePortraitViewer } from "../../ui/Portrait.tsx"
import { ResizeHandle, usePanelWidth } from "../../ui/ResizeHandle.tsx"
import { Sheet } from "../../ui/Sheet.tsx"
import { SubjectTabs, ToolTabs } from "../../ui/PanelTabs.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import type { ChatSession, ChatView } from "./session.ts"
import {
  chatPanels,
  isPanelTab,
  PanelContent,
  PendingPanelContent,
  preloadPanel,
  usePanelHere,
  usePanelTabs
} from "./panels.tsx"
import type { PendingChat } from "./pendingChat.ts"
/** Panel URL values are open strings, validated against the descriptors at use. */
export type PanelTab = string
declare module "@tanstack/react-router" {
  interface HistoryState {
    chatPanel?: boolean
  }
}

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

/** What the panel's tabs show: a saved chat's session, or a chat not made yet (pendingChat.ts). */
export type SidePanelContent =
  | {
      session: ChatSession
      view: ChatView
      focus: string | null
      onJump: (slot: SlotId) => void
      onEnable: () => void
      onSummaries: (summary: string) => void
    }
  | { pending: PendingChat; view: ChatView }

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
} & SidePanelContent) {
  // A tab mounts when first shown and stays mounted, hidden, while the panel is open, so
  // switching tabs never ends what's in one: a summary's edit with its unsaved text, say.
  const userId = useSession().user.id
  const { width, min, max, change, reset } = usePanelWidth(userId, "chat", 416, 260, wide)
  const [visited, setVisited] = useState<ReadonlySet<PanelTab>>(() => new Set([tab]))
  const [notesCard, setNotesCard] = usePlaceParam("notesCard", "")
  const notesFocus = (notesCard || null) as EntityId | null
  const setNotesFocus = (next: EntityId) => setNotesCard(next, true)
  const notes = (card: EntityId) => {
    setNotesFocus(card)
    onTab("notes")
  }
  // Every tab's code, once the shown one is up: a first visit then shows the tab at once.
  useEffect(() => {
    const preload = () => {
      for (const descriptor of chatPanels.list()) {
        descriptor.preload?.()
        preloadPanel(descriptor.component)
      }
    }
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(preload, { timeout: 1000 })
      return () => cancelIdleCallback(id)
    }
    const id = setTimeout(preload, 200)
    return () => clearTimeout(id)
  }, [])
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]))
  const all = usePanelTabs(content.view, tab)
  const tools = all.filter((t) => (t.descriptor.placement ?? "tools") === "tools")
  const cast = all.filter((t) => t.descriptor.placement === "cast")
  // While a portrait is shown, a character's chip opens theirs too, as a click on their portrait
  // would (on top of the others, or in place of them with one kept at a time); a chip never
  // closes one, since its click is first the tab's.
  const portraits = usePortraitViewer()
  const pick = (value: PanelTab) => {
    const avatar = cast.find((t) => t.value === value)?.avatar
    if (portraits && portraits.shown.length > 0 && avatar) portraits.show(avatar)
    onTab(value)
  }
  const nav = (
    <div className="flex flex-col gap-1 border-b border-border px-2 pt-1.5">
      <ToolTabs
        tabs={tools.map((t) => ({
          value: t.value,
          label: t.label,
          icon: t.descriptor.icon,
          // A tab with nothing to show before the first send says so where it's described.
          description:
            "pending" in content && !t.descriptor.pending
              ? `${t.descriptor.description ?? t.label} Available once the chat is saved.`
              : t.descriptor.description
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
          {/* The panel's whole width, its text at a readable measure (styles.css), unless the tab asks for less. */}
          <div data-measure className={t.descriptor.width === "readable" ? "max-w-[52rem]" : ""}>
            {"pending" in content ? (
              <PendingPanelContent
                key={t.descriptor.id}
                descriptor={t.descriptor}
                tab={t.value}
                active={t.value === tab}
                pending={content.pending}
                view={content.view}
              />
            ) : (
              <PanelContent
                key={t.descriptor.id}
                descriptor={t.descriptor}
                tab={t.value}
                active={t.value === tab}
                notesFocus={notesFocus}
                onNotes={notes}
                {...content}
              />
            )}
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
/**
 * The side panel's tab: the URL's, else on a wide screen the one this browser last had open
 * (a link to a message drops the URL's). A phone opens it only when asked: it covers the chat.
 */
export function usePanel(urlPanel: PanelTab | null, view: ChatView) {
  const navigate = useNavigate()
  const router = useRouter()
  const [pathname] = useState(() => router.state.location.pathname)
  const wide = useWide()
  const userId = useSession().user.id
  // Each user's own, read again when another signs in.
  const [remembered, setRemembered] = useState(() => ({ userId, tab: rememberedPanel(userId) }))
  const rememberedTab = remembered.userId === userId ? remembered.tab : rememberedPanel(userId)
  const explicit = useLocation({ select: (l) => l.state.chatPanel === true })
  const candidate = urlPanel ?? (!explicit && wide ? rememberedTab : null)
  const panel = usePanelHere(candidate, view)
  usePlaceNotice(
    urlPanel !== null && view.cast !== null && panel !== urlPanel
      ? "This panel is no longer available in this chat."
      : null
  )
  // The URL names the tab shown, so a refresh or a copied link keeps it.
  useEffect(() => {
    // Location state can update before the route's search props, and this component can
    // still be mounted while another route opens. Never normalize either newer place
    // from this render's old panel, or resolve a character tab before its cast loads.
    const latestPanel = router.latestLocation.search.panel
    if (
      view.loading ||
      router.latestLocation.pathname !== pathname ||
      (isPanelTab(latestPanel) ? latestPanel : null) !== urlPanel
    )
      return
    if (!explicit || panel !== urlPanel)
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, panel: panel ?? undefined }),
        state: (prev) => ({ ...prev, chatPanel: true }),
        replace: true,
        resetScroll: false
      })
  }, [navigate, router, pathname, urlPanel, panel, explicit, view.loading])
  // What a call reads when it's made, so `show` stays the same function from tab to tab and as
  // the chat updates: the message rows, the composer and the header take it, and a new one
  // re-rendered every row on each tab switch (night/tabperf).
  const latest = useRef({ view, urlPanel, panel })
  useLayoutEffect(() => {
    latest.current = { view, urlPanel, panel }
  })
  const show = useCallback(
    (next: PanelTab | null) => {
      if (next === latest.current.panel || (next !== null && !isPanelTab(next, latest.current.view))) return
      rememberPanel(userId, next)
      setRemembered({ userId, tab: next })
      void navigate({
        to: ".",
        search: ({ panel: _gone, ...prev }: Record<string, unknown>) =>
          next === null ? prev : { ...prev, panel: next },
        // On a phone, opening the sheet is a step in the history, so Back closes it.
        state: (prev) => ({ ...prev, chatPanel: true }),
        replace: next === null,
        resetScroll: false
      })
    },
    [navigate, userId]
  )
  /** Search params that keep the panel's tab: the one shown when the call is made. */
  const withPanel = useCallback(
    (search: Record<string, string>) => {
      const shown = latest.current.panel
      return { ...router.state.location.search, ...search, panel: shown ?? undefined }
    },
    [router]
  )
  return { panel, show, withPanel, wide, userId }
}
