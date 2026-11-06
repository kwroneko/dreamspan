import { useNavigate, useSearch } from "@tanstack/react-router"
import type { PresetContext } from "@rp/shared/inspectorApi.ts"
import type { ChatNotePosition } from "@rp/shared/editorApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore
} from "react"
import { useSession } from "../../session.ts"
import { UnsavedTracker } from "../../ui/UnsavedChanges.tsx"
import { CastContext, type CastView } from "../chat/cast.ts"
import type { ChatSession, ChatView } from "../chat/session.ts"
import { useTabRegion, useWorkbench, useWorkbenchTab } from "../workbench/tab.tsx"
import { useCaller } from "./caller.ts"
import { browserEnv } from "./backup.ts"
import { EditorStore } from "./store.ts"
import { boundEditorSurroundings, workspaceViews } from "./workspaceViews.ts"
/** The chat the workspace is in, for what a card's save offers after it (a rename in the history). */
interface WorkspaceChat {
  readonly chatId: string
  readonly forkId: string | null
}
/**
 * The library entries edited from a chat: one store each, shared by the panel's tab and the
 * full editor, which opens in a tab of its own beside the chat (a preset, or a card from its
 * panel tab).
 */
interface Workspace {
  /** A chat's own note is edited at its position, so its store is that position's. */
  store: (ref: RefId, chatNote?: ChatNotePosition) => EditorStore
  edits: { tracker: UnsavedTracker; stores: ReadonlyMap<string, EditorStore> }
  /** Opens an entry's editor in its own tab (features/workbench), beside the chat. */
  open: (ref: RefId, focus?: string) => void
  /** That tab's URL, for the opener's link. */
  href: (ref: RefId, focus?: string) => string
  close: () => void
  context: PresetContext | null | undefined
  chat: WorkspaceChat | undefined
}
const Context = createContext<Workspace | null>(null)
export const usePresetWorkspace = () => useContext(Context)
const emptyEdits = new UnsavedTracker()
/** Loaded workspace editors also mark their panel tab before that panel is first visited. */
export function useWorkspaceChanges() {
  const workspace = usePresetWorkspace()
  const tracker = workspace?.edits.tracker ?? emptyEdits
  const dirty = useSyncExternalStore(tracker.subscribe, tracker.snapshot)
  return [...(workspace?.edits.stores ?? [])].flatMap(([key, store]) =>
    dirty.has(key) && store.snapshot ? [store.snapshot.ref] : []
  )
}

export function PresetWorkspace({
  children,
  context,
  chat,
  live,
  compact = false,
  onOpen
}: {
  children: ReactNode
  context?: PresetContext | null | undefined
  chat?: WorkspaceChat | undefined
  /** The chat's session and cast, lent to the editor tabs opened from it. */
  live?: { session: ChatSession; cast: CastView } | undefined
  /** On a phone the full editor takes the side panel's place. */
  compact?: boolean
  onOpen?: () => void
}) {
  const call = useCaller()
  const userId = useSession().user.id
  const [stores] = useState(() => new Map<string, EditorStore>())
  const [edits] = useState(() => new UnsavedTracker())
  useEffect(() => () => edits.dispose(), [edits])
  const workbench = useWorkbench()
  const tab = useWorkbenchTab()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const href = (ref: RefId, focus?: string) => editorHref(ref, focus, chat, tab?.tabId)
  const open = (ref: RefId, focus?: string) => {
    // The chat it's opened from stays open beside its editor.
    if (tab) workbench?.pin(tab.tabId)
    if (compact) onOpen?.()
    if (workbench) workbench.open(href(ref, focus))
    else void navigate({ href: href(ref, focus) })
  }
  // A link from before tabs (`?editor=`): the editor opens in its own tab beside the chat.
  const legacy = typeof search.editor === "string" && search.editor ? (search.editor as RefId) : null
  const legacyFocus = typeof search.focus === "string" ? search.focus : undefined
  const openLegacy = useEffectEvent(() => {
    if (!legacy) return
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, editor: undefined, focus: undefined }),
      replace: true,
      resetScroll: false
    }).then(() => open(legacy, legacyFocus))
  })
  useEffect(() => {
    if (legacy) openLegacy()
  }, [legacy])
  const store = (ref: RefId, chatNote?: ChatNotePosition) => {
    const key = chatNote ? `${ref}\n${chatNote.chatId}\n${chatNote.forkId ?? ""}\n${chatNote.slotId ?? ""}` : ref
    let value = stores.get(key)
    if (!value) {
      value = new EditorStore(ref, userId, call, browserEnv, chatNote)
      stores.set(key, value)
      edits.add(key, value.unsavedSource)
    }
    return value
  }
  const workspace: Workspace = {
    store,
    edits: { tracker: edits, stores },
    context,
    chat,
    open,
    href,
    close: () => {}
  }
  // An editor tab opened from this chat edits through the same stores.
  const holder = useRef<LiveChat | null>(null)
  useEffect(() => {
    holder.current = live ? { workspace, ...live } : null
  })
  const chatId = chat?.chatId
  useEffect(() => {
    if (!chatId || !holder.current) return
    return publishLive(tab?.tabId ?? chatId, holder)
  }, [chatId, tab?.tabId, holder])
  useEffect(liveChanged, [context, live?.cast, chat?.forkId])
  return <Context value={workspace}>{children}</Context>
}

// --- The chats open in the workbench, for editor tabs opened from them.

interface LiveChat {
  readonly workspace: Workspace
  readonly session: ChatSession
  readonly cast: CastView
}
const liveChats = new Map<string, { readonly current: LiveChat | null }>()
const liveListeners = new Set<() => void>()
/** What each chat lent at the last change: a stable snapshot between changes. */
let liveShown = new Map<string, LiveChat | null>()
const liveChanged = () => {
  liveShown = new Map([...liveChats].map(([id, holder]) => [id, holder.current]))
  for (const listener of liveListeners) listener()
}
const publishLive = (sourceId: string, holder: { readonly current: LiveChat | null }) => {
  liveChats.set(sourceId, holder)
  liveChanged()
  return () => {
    if (liveChats.get(sourceId) !== holder) return
    liveChats.delete(sourceId)
    liveChanged()
  }
}
const subscribeLive = (listener: () => void) => {
  liveListeners.add(listener)
  return () => void liveListeners.delete(listener)
}
const useLiveChat = (chatId: string, sourceId: string | undefined, forkId: string | undefined) =>
  useSyncExternalStore(subscribeLive, () => {
    const source = sourceId ? liveShown.get(sourceId) : undefined
    if (source?.session.id === chatId) return source
    // Older links have no source tab; match their branch before falling back to another view.
    const candidates = [...liveShown.values()].filter((live) => live?.session.id === chatId)
    return candidates.findLast((live) => live?.workspace.chat?.forkId === forkId) ?? candidates.at(-1) ?? null
  })

/**
 * An editor, named as a region: in a workbench tab the tab is the region, so its header (the
 * switcher, Save, Close) is inside it; elsewhere this section is.
 */
export function Region({ label, className, children }: { label: string; className: string; children: ReactNode }) {
  const inTab = useTabRegion(label)
  return inTab ? (
    <div className={className}>{children}</div>
  ) : (
    <section aria-label={label} className={className}>
      {children}
    </section>
  )
}

/**
 * An editor opened from a chat scrolls on its own, below the tab's header, with the padding
 * and the sticky toolbar's place the chat's large editors had (searchNavigation.ts).
 */
export function BoundScroll({ children }: { children: ReactNode }) {
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-(--scroll-pad) [--scroll-pad:0.75rem] sm:[--scroll-pad:1rem]"
      data-testid="preset-scroll"
      data-preset-scroll
    >
      {children}
    </div>
  )
}

/** An entry's editor, as a tab of its own: bound to the chat it's opened from (live.ts). */
export const editorHref = (
  ref: RefId,
  focus: string | undefined,
  chat: WorkspaceChat | undefined,
  sourceId?: string
) => {
  const params = new URLSearchParams()
  if (focus) params.set("focus", focus)
  if (chat) {
    params.set("chat", chat.chatId)
    if (chat.forkId) params.set("chatFork", chat.forkId)
    if (sourceId) params.set("chatTab", sourceId)
  }
  const query = params.toString()
  return `/library/${encodeURIComponent(ref)}${query ? `?${query}` : ""}`
}

/**
 * The editor in a tab opened from a chat: the chat's stores, preset context and cast while that
 * chat is open in the workbench, so the panel and the editor show the same text.
 */
export function ChatBoundEditor({
  refId,
  focus,
  chatId,
  onClose,
  children
}: {
  refId: RefId
  focus: string | undefined
  chatId: string
  onClose: (() => void) | undefined
  children: (bound: {
    store: EditorStore | undefined
    context: PresetContext | null | undefined
    current: WorkspaceChat | undefined
    session: ChatSession | undefined
  }) => ReactNode
}) {
  const search = useSearch({ strict: false }) as { chatTab?: unknown; chatFork?: unknown }
  const live = useLiveChat(
    chatId,
    typeof search.chatTab === "string" ? search.chatTab : undefined,
    typeof search.chatFork === "string" ? search.chatFork : undefined
  )
  const views = useSyncExternalStore(workspaceViews.subscribe, workspaceViews.snapshot, workspaceViews.snapshot)
  if (!live) return children({ store: undefined, context: undefined, current: undefined, session: undefined })
  const registered = focus === undefined ? undefined : views.entries.find((v) => v.id === focus)
  const content = registered ? (
    <Region label={registered.label} className="flex min-h-0 flex-1 flex-col">
      <BoundScroll>
        <LiveView
          session={live.session}
          render={(view) => <registered.component refId={refId} onClose={onClose} session={live.session} view={view} />}
        />
      </BoundScroll>
    </Region>
  ) : (
    children({
      store: live.workspace.store(refId),
      context: live.workspace.context,
      current: live.workspace.chat,
      session: live.session
    })
  )
  return (
    <Context value={live.workspace}>
      <CastContext value={live.cast}>
        <Surroundings cast={live.cast}>{content}</Surroundings>
      </CastContext>
    </Context>
  )
}

/** The chat's surroundings for its editor's tab (`boundEditorSurroundings`). */
function Surroundings({ cast, children }: { cast: CastView; children: ReactNode }) {
  const snapshot = useSyncExternalStore(
    boundEditorSurroundings.subscribe,
    boundEditorSurroundings.snapshot,
    boundEditorSurroundings.snapshot
  )
  return [...snapshot.entries]
    .sort((a, b) => b.order - a.order)
    .reduce<ReactNode>(
      (inner, entry) => (
        <entry.component key={entry.id} cast={cast}>
          {inner}
        </entry.component>
      ),
      children
    )
}

function LiveView({ session, render }: { session: ChatSession; render: (view: ChatView) => ReactNode }) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  return render(view)
}
