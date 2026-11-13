import { createPortal } from "react-dom"
import { kindRootProps, kindTitle, useChatKindLook } from "./kindLooks.ts"
import { usePlaceParam, usePlaceNotice } from "../../usePlaceParam.ts"
// The chat panel host: descriptors own its tabs and bodies; the host owns layout and retention.
import type { ChatId, EntityId, SlotId } from "@rp/shared/chat.ts"
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router"
import { Button } from "../../ui/Button.tsx"
import { useSession } from "../../session.ts"
import { ResizeHandle, usePanelWidth } from "../../ui/ResizeHandle.tsx"
import { Sheet } from "../../ui/Sheet.tsx"
import { Away } from "../../ui/away.ts"
import { useTabShown } from "../workbench/tab.tsx"
import { useWorkspaceChanges } from "../editor/PresetWorkspace.tsx"
import { UnsavedScope, useUnsavedTabs } from "../../ui/UnsavedChanges.tsx"
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

// First-send navigation replaces the pending route (and its tab strip). Keep this transient
// handover by chat id, independent of the workbench's nested histories.
const panelFocusHandovers = new Set<ChatId>()
export const carryPanelFocus = (chatId: ChatId, wanted: boolean) => {
  if (wanted) panelFocusHandovers.add(chatId)
  else panelFocusHandovers.delete(chatId)
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
  compact = false,
  className = ""
}: {
  userId: string
  open: PanelTab | null
  wide: boolean
  view: ChatView
  /** Opens the panel at a tab, or closes it when that tab is the one open. */
  onToggle: (tab: PanelTab) => void
  /** One icon that opens the panel at its last tab and hides it (the chat header's). */
  compact?: boolean
  /** The compact button's size where it sits (a tab strip's are smaller). */
  className?: string
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
          open === null
            ? "Click to open the chat panel: cast, settings, lorebooks, notes and summaries"
            : "Click to hide the chat panel"
        }
        icon="panel"
        aria-expanded={open !== null}
        aria-pressed={open !== null}
        className={`${className} ${open === null ? "" : "bg-surface-raised text-text"}`}
        onClick={toggle}
      />
    )
  if (!wide || open !== null)
    return (
      <Button
        hint={open === null ? "Click to show the chat panel." : "Click to hide the chat panel."}
        variant="ghost"
        aria-expanded={open !== null}
        title={
          open === null
            ? "Click to open the chat panel: cast, settings, lorebooks, notes and summaries"
            : "Click to hide the chat panel"
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
          hint={`Click to open ${tab.label}${tab.descriptor.description ? `: ${tab.descriptor.description}` : ""}`}
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
  host = null,
  ...content
}: {
  tab: PanelTab
  wide: boolean
  /** The chat's title, so a phone's sheet says which chat it's about. */
  title: string
  onTab: (tab: PanelTab) => void
  onClose: () => void
  /** Beside the workbench's frames rather than beside the chat (features/workbench). */
  host?: HTMLElement | null
} & SidePanelContent) {
  // A tab mounts when first shown and stays mounted, hidden, while the panel is open, so
  // switching tabs never ends what's in one: a summary's edit with its unsaved text, say.
  const { tracker, dirty } = useUnsavedTabs()
  // Shown apart from the chat (beside the frames, or as a sheet), it takes the chat kind's accent itself.
  const kindRoot = kindRootProps(useChatKindLook(content.view.chat?.kind))
  const editorChanges = useWorkspaceChanges()
  const savedId = "session" in content ? content.session.id : null
  const [focusTab] = useState(() => (savedId !== null && panelFocusHandovers.has(savedId) ? tab : null))
  const restoreFocus = focusTab !== null
  useLayoutEffect(() => {
    if (savedId !== null) panelFocusHandovers.delete(savedId)
  }, [savedId])
  const navRef = useRef<HTMLDivElement>(null)
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
  const nav = (
    <div ref={navRef} data-chat-panel-tabs className="flex shrink-0 flex-col">
      <div className="flex h-shell-header shrink-0 items-center border-b border-border px-2 py-2 *:min-w-0 *:flex-1">
        <ToolTabs
          tabs={tools.map((t) => ({
            value: t.value,
            dirty: dirty.has(t.value) || editorChanges.some((ref) => t.descriptor.holdsEditor?.(ref, t.value)),
            label: t.label,
            icon: t.descriptor.icon,
            savedOnly: t.descriptor.savedOnly,
            // A tab with nothing to show before the first send says so where it's described.
            description:
              "pending" in content && !t.descriptor.pending
                ? `${t.descriptor.description ?? t.label} Available once the chat is saved.`
                : t.descriptor.description
          }))}
          value={tab}
          onValueChange={onTab}
          label="Chat panel"
          focusOnMount={restoreFocus && tools.some((tab) => tab.value === focusTab)}
          moreLabel="More tools"
        />
      </div>
      <div className="border-b border-border px-2 pt-1">
        <SubjectTabs
          tabs={cast.map((t) => ({
            value: t.value,
            dirty: dirty.has(t.value) || editorChanges.some((ref) => t.descriptor.holdsEditor?.(ref, t.value)),
            label: t.label,
            avatar: t.avatar,
            icon: t.descriptor.icon,
            note: t.note
          }))}
          value={tab}
          onValueChange={onTab}
          focusOnMount={restoreFocus && cast.some((tab) => tab.value === focusTab)}
          label="Characters"
        />
        {cast.length === 0 && <div className="h-0.5" />}
      </div>
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
          className={
            t.descriptor.fill
              ? "@container flex min-h-0 flex-1 flex-col outline-none"
              : "@container min-h-0 flex-1 overflow-y-auto px-4 py-4 outline-none"
          }
        >
          {/* The panel's whole width, its text at a readable measure (styles.css), unless the tab asks for less. */}
          <div
            data-measure
            className={
              t.descriptor.fill
                ? "flex min-h-0 flex-1 flex-col"
                : t.descriptor.width === "readable"
                  ? "max-w-[52rem]"
                  : ""
            }
          >
            <UnsavedScope tracker={tracker} tab={t.value}>
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
            </UnsavedScope>
          </div>
        </div>
      )
  )
  // The modal belongs to the main landmark; only the covered chat content is hidden.
  if (!wide)
    return (
      <Sheet
        open
        onOpenChange={(open) => !open && onClose()}
        title={kindTitle(title, content.view.chat?.kind)}
        container={document.getElementById("content")}
        initialFocus={
          restoreFocus
            ? () => navRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null
            : undefined
        }
      >
        <div {...kindRoot} className="flex min-h-0 flex-1 flex-col">
          {nav}
          {panels}
        </div>
      </Sheet>
    )
  const aside = (
    <aside
      aria-label="Chat panel"
      {...kindRoot}
      style={{ ...kindRoot.style, width }}
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
  // Shown beside the frames even while this chat's tab is behind another (its editor's, say).
  return host ? createPortal(<Away value={false}>{aside}</Away>, host) : aside
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
  const panel = usePanelHere(candidate === "display" ? "interface" : candidate, view)
  usePlaceNotice(
    urlPanel !== null && urlPanel !== "display" && view.cast !== null && panel !== urlPanel
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
  // A phone's sheet covers everything: once this chat's tab is behind another (an editor opened
  // from it, or a resize below the breakpoint while it was) the sheet closes rather than coming
  // back over the chat, as opening a large editor from it closes it. The layout says so, not
  // the tab's place on screen, which a resize moves for a moment while the frames remount.
  const away = !useTabShown(wide)
  useEffect(() => {
    if (!wide && away && latest.current.panel !== null) show(null)
  }, [wide, away, show])
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
