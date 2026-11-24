import { createPortal } from "react-dom"
import { kindRootProps, kindTitle, useChatKindLook } from "./kindLooks.ts"
import { usePlaceParam, usePlaceNotice } from "../../usePlaceParam.ts"
// The chat panel host: descriptors own its tabs and bodies; the host owns layout and retention.
import type { ChatId, EntityId, SlotId } from "@dreamspan/shared/chat.ts"
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router"
import { Button } from "../../ui/Button.tsx"
import { useSession } from "../../session.ts"
import { ResizeHandle, usePanelWidth } from "../../ui/ResizeHandle.tsx"
import { Sheet } from "../../ui/Sheet.tsx"
import { Away } from "../../ui/away.ts"
import { useTabShown, useWorkbenchTab } from "../workbench/tab.tsx"
import { useWorkspaceChanges } from "../editor/PresetWorkspace.tsx"
import { UnsavedBranchShown, UnsavedScope, useUnsavedTabs } from "../../ui/UnsavedChanges.tsx"
import { SubjectTabs } from "../../ui/PanelTabs.tsx"
import { inOrder, MAX_STORED, storedOrder } from "../../ui/tabOrder.ts"
import { ToolTabs } from "../../ui/ToolTabs.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { IconButton } from "../../ui/Tooltip.tsx"
import type { ChatSession, ChatView } from "./session.ts"
import {
  chatPanels,
  CloseChatPanelSheet,
  isPanelTab,
  PanelContent,
  PendingPanelContent,
  preloadPanel,
  usePanelHere,
  usePanelTabs
} from "./panels.tsx"
import type { PendingChat } from "./pendingChat.ts"
import { chatHeaderActions, pendingChatHeaderActions } from "./presentation.tsx"
import { isPendingChat, NOT_STARTED } from "./chatStarted.ts"
import { composerTextbox } from "./composerFocus.ts"
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

// --- Whether the panel is open and at which tab: the URL's `panel` says (a chat's tab keeps it,
// so a reload or a copied link shows it). Besides, this page remembers in memory, per user,
// the tab last open, so a chat opened from a place without a panel (Home) shows the one this
// browser tab had; nothing is stored, so no other browser tab follows it (owner, 2026-11-18).

/** The tab open, absent while the panel is closed. */
const lastOpen = new Map<string, PanelTab>()
/** The tab last open, closed since or not: where the panel opens on a phone. */
const lastTab = new Map<string, PanelTab>()

/** The tab open when the user last used the panel in this page, or null when they last closed it. */
export const rememberedPanel = (userId: string) => lastOpen.get(userId) ?? null

export const rememberPanel = (userId: string, tab: PanelTab | null) => {
  if (tab === null) lastOpen.delete(userId)
  else {
    lastOpen.set(userId, tab)
    lastTab.set(userId, tab)
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
    const remembered = lastTab.get(userId)
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

/**
 * The header's panel toggle isn't there: a plugin or setting disabled `chat.panel` in the
 * header's slot. Disabling leaves out only that button (as for any other part); the panel still
 * opens from the chat (a portrait, a link), so it then carries its own Hide panel.
 */
function useHeaderToggleGone(pending: boolean) {
  const slot = pending ? pendingChatHeaderActions : chatHeaderActions
  return useSyncExternalStore(
    slot.subscribe,
    () => !slot.snapshot().entries.some((entry) => entry.id === "chat.panel"),
    () => false
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
  onClose: (restoreFocus?: boolean) => void | Promise<void>
  /** Beside the workbench's frames rather than beside the chat (features/workbench). */
  host?: HTMLElement | null
} & SidePanelContent) {
  // A tab mounts when first shown and stays mounted, hidden, while the panel is open, so
  // switching tabs never ends what's in one: a summary's edit with its unsaved text, say.
  // A chat's own notes count on their branch only (owner, 2026-11-24): the branch shown here.
  const sessionId = "session" in content ? content.session.id : null
  const branch = sessionId === null ? null : { chatId: sessionId, forkId: content.view.forkId ?? null }
  const { tracker, dirty } = useUnsavedTabs(branch)
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
  const { width, min, max, change, reset } = usePanelWidth("chat", 416, 260, wide)
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
  // The tools in the user's order (an account display choice); new and plugin tools follow it.
  const viewPrefs = useViewPrefs()
  const tabOrder = viewPrefs.prefs.panelTabOrder
  const usualTools = all.filter((t) => (t.descriptor.placement ?? "tools") === "tools")
  const tools = inOrder(usualTools, tabOrder)
  const reordered = tools.some((t, index) => t.value !== usualTools[index]!.value)
  const cast = all.filter((t) => t.descriptor.placement === "cast")
  // A phone's sheet has its own Close.
  const ownClose = useHeaderToggleGone("pending" in content) && wide
  const nav = (
    <div ref={navRef} data-chat-panel-tabs className="flex shrink-0 flex-col">
      <div className="flex h-shell-header shrink-0 items-center gap-1 border-b border-border px-2 py-2">
        <div className="min-w-0 flex-1">
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
                  : t.descriptor.savedOnly && isPendingChat(content.view.chat)
                    ? `${t.descriptor.description ?? t.label} ${NOT_STARTED}`
                    : t.descriptor.description
            }))}
            value={tab}
            onValueChange={onTab}
            label="Chat panel"
            focusOnMount={restoreFocus && tools.some((tab) => tab.value === focusTab)}
            moreLabel="More tools"
            trailingControlVisible={ownClose}
            onReorder={(values) => {
              const order = storedOrder(tabOrder, values)
              if (inOrder(usualTools, order).some((tool, index) => tool.value !== values[index])) {
                showToast({ title: `This tab order can't be saved. Only ${MAX_STORED} positions can be stored.` })
                return
              }
              viewPrefs.change({ panelTabOrder: order })
            }}
            onResetOrder={() => viewPrefs.change({ panelTabOrder: [] })}
            reordered={reordered}
          />
        </div>
        {ownClose && (
          <IconButton
            label="Hide panel"
            hint="Click to hide the chat panel"
            icon="panel"
            aria-expanded
            aria-pressed
            className="shrink-0 bg-surface-raised text-text"
            onClick={(event) => void onClose(event.detail === 0)}
          />
        )}
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
              <UnsavedBranchShown branch={branch}>
                {"pending" in content ? (
                  <PendingPanelContent
                    key={t.descriptor.id}
                    descriptor={t.descriptor}
                    tab={t.value}
                    active={t.value === tab}
                    pending={content.pending}
                    view={content.view}
                  />
                ) : t.descriptor.savedOnly && isPendingChat(content.view.chat) ? (
                  // A new chat not started yet: the tab stays in its place, saying why it waits.
                  <p role="note" className="text-sm text-muted">
                    {NOT_STARTED}
                  </p>
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
              </UnsavedBranchShown>
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
        onOpenChange={(open) => {
          if (!open) void onClose()
        }}
        title={kindTitle(title, content.view.chat?.kind)}
        dedupeLabels={false}
        container={document.getElementById("content")}
        initialFocus={
          restoreFocus
            ? () => navRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null
            : undefined
        }
      >
        <CloseChatPanelSheet value={onClose}>
          <div {...kindRoot} className="flex min-h-0 flex-1 flex-col">
            {nav}
            {panels}
          </div>
        </CloseChatPanelSheet>
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
type CastMembers = Pick<NonNullable<ChatView["cast"]>, "participants" | "playedByMe">

/**
 * The cards one cast change put in another's place, old to new: the persona switched (any
 * picker: the composer's Speak as, the Cast tab's, This chat's), or a card swapped in place
 * (Use another version). A card that only left, or only joined, replaces nothing.
 */
const castReplacements = (before: CastMembers, after: CastMembers): ReadonlyArray<readonly [string, string]> => {
  const pairs = new Map<string, string>()
  const [was] = before.playedByMe
  const [now] = after.playedByMe
  if (before.playedByMe.length === 1 && after.playedByMe.length === 1 && was !== now) pairs.set(was!, now!)
  if (before.participants.length === after.participants.length) {
    const changed = before.participants.flatMap((id, at) => (after.participants[at] === id ? [] : [at]))
    const at = changed[0]
    if (changed.length === 1 && at !== undefined) {
      const out = before.participants[at]!
      const into = after.participants[at]!
      if (!after.participants.includes(out) && !before.participants.includes(into)) pairs.set(out, into)
    }
  }
  return [...pairs]
}

/**
 * A character tab whose card was replaced in place gives way to its replacement's: the persona's
 * tab, open as the persona changes, opens the new persona's. Returns the tab to show instead of
 * `asked`, or null; the URL then follows with replace (usePanel), so Back never lands on the
 * gone card's tab. Later, a tab of a card replaced on this branch and no longer in the cast (a
 * Back to it) follows too. A card that only left keeps its tab as before (characters/panels.tsx).
 */
function useCastFollow(asked: PanelTab | null, view: ChatView) {
  const cast = view.cast
  const [seen, setSeen] = useState(() => ({
    cast,
    chat: view.chat?.id ?? null,
    forkId: view.forkId,
    follows: new Map<string, string>() as ReadonlyMap<string, string>,
    /** The tab open when its card was replaced, and its replacement's, until the URL moves on. */
    open: null as { readonly from: PanelTab; readonly to: PanelTab } | null
  }))
  let { follows, open } = seen
  if (open !== null && asked !== open.from) open = null
  if (seen.cast !== cast) {
    // Only a change in place: another branch or chat isn't a replacement.
    const inPlace =
      seen.cast !== null && cast !== null && seen.chat === (view.chat?.id ?? null) && seen.forkId === view.forkId
    const pairs = inPlace ? castReplacements(seen.cast!, cast!) : []
    if (pairs.length > 0) {
      const next = new Map(follows)
      for (const [from, to] of pairs) next.set(from, to)
      follows = next
      const hit = pairs.find(([from]) => asked === `card:${from}`)
      if (hit) open = { from: asked!, to: `card:${hit[1]}` }
    } else if (!inPlace) follows = new Map()
  }
  if (seen.cast !== cast || seen.follows !== follows || seen.open !== open)
    setSeen({ cast, chat: view.chat?.id ?? null, forkId: view.forkId, follows, open })
  return { tab: open?.to ?? followed(asked, cast, follows), follows, cast }
}

/** Where a tab of a card replaced on this branch, and no longer in the cast, goes: its replacement's. */
const followed = (tab: PanelTab | null, cast: ChatView["cast"], follows: ReadonlyMap<string, string>) => {
  if (cast === null || !tab?.startsWith("card:")) return null
  const members: ReadonlyArray<string> = [...cast.participants, ...cast.playedByMe]
  const member = (id: string) => members.includes(id)
  let id = tab.slice(5)
  if (member(id)) return null
  const visited = new Set<string>()
  while (!member(id)) {
    if (visited.has(id)) return null
    visited.add(id)
    const to = follows.get(id)
    if (to === undefined) return null
    id = to
  }
  return `card:${id}`
}

/**
 * The side panel's tab: the URL's, else on a wide screen the one this browser last had open
 * (a link to a message drops the URL's). A phone opens it only when asked: it covers the chat.
 */
export function usePanel(urlPanel: PanelTab | null, view: ChatView) {
  const navigate = useNavigate()
  const router = useRouter()
  const workbenchTab = useWorkbenchTab()
  const chatMain = useRef<HTMLDivElement>(null)
  const restoreFocusOnClose = useRef(false)
  const [pathname] = useState(() => router.state.location.pathname)
  const wide = useWide()
  const userId = useSession().user.id
  // Each user's own, read again when another signs in.
  const [remembered, setRemembered] = useState(() => ({ userId, tab: rememberedPanel(userId) }))
  const rememberedTab = remembered.userId === userId ? remembered.tab : rememberedPanel(userId)
  const explicit = useLocation({ select: (l) => l.state.chatPanel === true })
  const asked = urlPanel ?? (!explicit && wide ? rememberedTab : null)
  const follow = useCastFollow(asked, view)
  const candidate = follow.tab ?? asked
  const panel = usePanelHere(candidate === "display" ? "interface" : candidate, view)
  useLayoutEffect(() => {
    if (panel !== null || !restoreFocusOnClose.current) return
    restoreFocusOnClose.current = false
    if (document.activeElement !== document.body) return
    const main = chatMain.current
    if (!main) return
    composerTextbox(main)?.focus({ preventScroll: true })
    if (document.activeElement === document.body) main.focus({ preventScroll: true })
    // The panel can outlive the chat's visibility when one of its editors covers the chat.
    if (document.activeElement === document.body && workbenchTab)
      document.querySelector<HTMLElement>(`[data-tab="${CSS.escape(workbenchTab.tabId)}"] [role="tab"]`)?.focus()
  }, [panel, workbenchTab])
  usePlaceNotice(
    follow.tab === null && urlPanel !== null && urlPanel !== "display" && view.cast !== null && panel !== urlPanel
      ? "This panel is no longer available in this chat."
      : null
  )
  // A tab shown from the URL (a reload, a link) is the one this page goes on with.
  useEffect(() => {
    if (panel !== null) rememberPanel(userId, panel)
  }, [userId, panel])
  // A closed panel's tab, its card replaced meanwhile, reopens at the replacement's.
  useEffect(() => {
    const tab = lastTab.get(userId) ?? null
    const next = followed(tab, follow.cast, follow.follows)
    if (next !== null) lastTab.set(userId, next)
  }, [userId, follow.cast, follow.follows])
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
  const latest = useRef({ view, urlPanel, panel, router })
  useLayoutEffect(() => {
    latest.current = { view, urlPanel, panel, router }
  })
  const show = useCallback(
    (next: PanelTab | null) => {
      if (next === latest.current.panel || (next !== null && !isPanelTab(next, latest.current.view))) return
      rememberPanel(userId, next)
      setRemembered({ userId, tab: next })
      return navigate({
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
  const close = (restoreFocus = false) => {
    restoreFocusOnClose.current = restoreFocus
    return show(null)
  }
  // A phone's sheet covers everything: once this chat's tab is behind another (an editor opened
  // from it, or a resize below the breakpoint while it was) the sheet closes rather than coming
  // back over the chat, as opening a large editor from it closes it. The layout says so, not
  // the tab's place on screen, which a resize moves for a moment while the frames remount.
  const away = !useTabShown(wide)
  useEffect(() => {
    if (!wide && away && latest.current.panel !== null) show(null)
  }, [wide, away, show])
  // Keep the mutable router behind the ref too. React Compiler otherwise infers the
  // search object as a dependency and replaces this callback on every panel navigation.
  /** Search params that keep the panel's tab: the one shown when the call is made. */
  const withPanel = useCallback((search: Record<string, string>) => {
    const shown = latest.current.panel
    return { ...latest.current.router.state.location.search, ...search, panel: shown ?? undefined }
  }, [])
  return { panel, show, close, chatMain, withPanel, wide, userId }
}
