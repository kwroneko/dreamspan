// The workshop beside a story (spec/WORKSHOP.md §4, W9): the story's Workshop tab shows a whole
// workshop chat, its messages and its composer, at the panel's width. It's a chat of its own: its
// own session and event stream, its own branch (`side.fork`) and dialogs (`side.messageDialog`)
// in the URL, so neither chat moves or opens anything in the other. The assistant reads the story
// through its story tools; nothing said here is in the story's context.
import type { Chat, ChatId, ForkId, PathEntry } from "@rp/shared/chat.ts"
import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import { AsyncResult, Atom } from "effect/reactivity"
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react"
import { useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Menu, MenuItem, MenuSeparator } from "../../ui/Menu.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { IconLink } from "../../ui/Tooltip.tsx"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { castView, CastContext } from "../chat/cast.ts"
import { ChatPlaceScope, chatPlaceKey } from "../chat/chatPlace.ts"
import { type Flashes, MessageList } from "../chat/ChatPage.tsx"
import { KindBadge } from "../chat/KindBadge.tsx"
import { kindRootProps, useChatKindLook } from "../chat/kindLooks.ts"
import type { PanelProps } from "../chat/panels.tsx"
import { ChatSurfaceProviders, chatComposer, chatComposerNotes, chatOverlays } from "../chat/presentation.tsx"
import { ChatSession, type ChatView } from "../chat/session.ts"
import { SkeletonMessages } from "../chat/SkeletonMessages.tsx"
import { useWorkbench, useWorkbenchTab } from "../workbench/tab.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { chooseSideChat, SIDE_CHAT_PARAM, SIDE_CHAT_SCOPE, SIDE_CHATS_KEY } from "./sideChat.ts"

const attachedTo = Atom.family((chatId: ChatId) =>
  AppClient.query("ListAttachedWorkshops", { chatId }, { reactivityKeys: [SIDE_CHATS_KEY, chatId] })
)

/** The page's own: the portrait column and the editor tabs' workspace stay the story's. */
const PAGE_PROVIDERS: ReadonlySet<string> = new Set(["chat.portraits", "chat.preset-workspace"])

const ABOUT =
  "Talk about this story with an assistant, out of character. It reads the story on the branch you last wrote in; nothing said here reaches the story."

/** Opens a chat in a tab of its own, beside this one. */
function useOpenOwn() {
  const workbench = useWorkbench()
  const tab = useWorkbenchTab()
  const navigate = useNavigate()
  return useCallback(
    (href: string) => {
      if (workbench) workbench.openIn(tab ? workbench.frameOf(tab.tabId) : undefined, href)
      else void navigate({ href })
    },
    [workbench, tab, navigate]
  )
}

export function WorkshopSidePanel({ session }: PanelProps) {
  const atom = attachedTo(session.id)
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  const [wanted, setWanted] = usePlaceParam(SIDE_CHAT_PARAM, "")
  const action = useAction()
  const list = AsyncResult.isSuccess(result) ? result.value : null
  const choice = list === null ? null : chooseSideChat(list, wanted || null)
  const waiting = result.waiting
  // A workshop the list doesn't have is read for once more (one just made from the ⋯ menu, or in
  // another browser tab) before it's taken as gone, and the newest shown instead.
  const missing = choice?.missing === true
  const [checked, setChecked] = useState<{ readonly id: string; readonly list: unknown } | null>(null)
  if (missing && checked?.id !== wanted) setChecked({ id: wanted, list })
  useEffect(() => {
    if (checked !== null) refresh()
  }, [checked, refresh])
  // Gone once a list read after the check still doesn't have it.
  const confirmed = missing && checked?.id === wanted && checked.list !== list && !waiting
  useEffect(() => {
    if (!confirmed) return
    showToast({ title: "That workshop isn't beside this chat any more." })
    setWanted("", true)
  }, [confirmed, setWanted])
  const start = async () => {
    const made = await action.run((client) => client("CreateWorkshop", { attachTo: session.id }), [SIDE_CHATS_KEY])
    if (made.ok) setWanted(made.value.id)
  }
  const gone = useCallback(() => {
    setWanted("", true)
    refresh()
  }, [setWanted, refresh])

  if (AsyncResult.isFailure(result) && list === null)
    return (
      <div className="px-4 py-4">
        <Alert tone="danger">The workshops beside this chat couldn’t be read.</Alert>
      </div>
    )
  if (choice === null || missing) return <p className="px-4 py-4 text-sm text-muted">Loading the workshop…</p>
  const startButton = (
    <Button
      variant={choice.shown === null ? "primary" : "secondary"}
      className="self-start"
      pending={action.pending}
      hint="Starts a new workshop beside this chat, to talk about it out of character."
      onClick={() => void start()}
    >
      Start a workshop
    </Button>
  )
  if (choice.shown === null)
    return (
      <div className="flex flex-col gap-3 px-4 py-4" data-side-chat-empty="">
        <p className="text-sm text-muted">{ABOUT}</p>
        {startButton}
        {action.error && <Alert tone="danger">The workshop couldn’t be started: {action.error.message}</Alert>}
      </div>
    )
  return (
    <SideChat
      key={choice.shown.id}
      chat={choice.shown}
      header={
        <SideChatHeader
          shown={choice.shown}
          all={list ?? []}
          starting={action.pending}
          onPick={(id) => setWanted(id)}
          onStart={() => void start()}
        />
      }
      error={action.error ? `The workshop couldn’t be started: ${action.error.message}` : null}
      onGone={gone}
    />
  )
}

function SideChatHeader({
  shown,
  all,
  starting,
  onPick,
  onStart
}: {
  shown: Chat
  all: ReadonlyArray<Chat>
  starting: boolean
  onPick: (id: ChatId) => void
  onStart: () => void
}) {
  const open = useOpenOwn()
  const href = `/chats/${shown.id}`
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
      <KindBadge kind={shown.kind} />
      <Menu
        label="Workshops beside this chat"
        align="start"
        hint="Switches to another workshop beside this chat, or starts a new one."
        trigger={
          <button
            type="button"
            aria-label={`Workshop: ${shown.title}`}
            className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-sm font-medium hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus outline-none"
          >
            <span className="min-w-0 truncate">{shown.title}</span>
            <Icon name="down" className="shrink-0 text-muted" />
          </button>
        }
      >
        {all.map((chat) => (
          <MenuItem
            key={chat.id}
            {...(chat.id === shown.id ? { icon: "check" as const } : {})}
            description={chat.id === shown.id ? "Shown now." : "Shows this workshop here instead."}
            onClick={() => onPick(chat.id)}
          >
            {chat.title}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          icon="plus"
          disabled={starting}
          description="Starts a new workshop beside this chat, to talk about it out of character."
          onClick={onStart}
        >
          New workshop
        </MenuItem>
      </Menu>
      <IconLink
        label="Open in its own tab"
        hint="Opens this workshop in a tab of its own, with its settings and panels."
        icon="external"
        href={href}
        onOpen={() => open(href)}
      />
    </div>
  )
}

/** One workshop beside the story: its own session, at the panel's width. */
function SideChat({
  chat,
  header,
  error,
  onGone
}: {
  chat: Chat
  header: ReactNode
  error: string | null
  onGone: () => void
}) {
  const registry = useContext(RegistryContext)
  const userId = useSession().user.id
  const forkKey = chatPlaceKey(SIDE_CHAT_SCOPE, "fork")
  const [urlFork, setUrlFork] = usePlaceParam(forkKey, "")
  const fork = (urlFork || null) as ForkId | null
  // Opened once on the URL's branch; later the URL moves this session (Back, Forward) rather
  // than starting another.
  const [opening] = useState(fork)
  const [session, setSession] = useState<ChatSession | null>(null)
  useLayoutEffect(() => {
    const next = new ChatSession(chat.id, opening, registry, userId, (title) => showToast({ title }))
    // Shown once its first page is read, as a chat page's is (ChatPage.tsx).
    let shown = false
    const ready = () => {
      if (shown || next.snapshot().loading) return
      shown = true
      setSession(next)
    }
    const unsubscribe = next.subscribe(ready)
    next.start(null)
    ready()
    return () => {
      unsubscribe()
      next.dispose()
    }
  }, [chat.id, opening, registry, userId])
  if (session === null || session.id !== chat.id)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <p className="px-4 py-4 text-sm text-muted">Loading the workshop…</p>
      </div>
    )
  return (
    <SideChatSurface session={session} fork={fork} onFork={setUrlFork} header={header} error={error} onGone={onGone} />
  )
}

function SideChatSurface({
  session,
  fork,
  onFork,
  header,
  error,
  onGone
}: {
  session: ChatSession
  fork: ForkId | null
  onFork: (fork: string) => void
  header: ReactNode
  error: string | null
  onGone: () => void
}) {
  const view: ChatView = useSyncExternalStore(session.subscribe, session.snapshot)
  const open = useOpenOwn()
  const flashes = useRef<Flashes>({ opened: 0, again: false })
  const cast = useMemo(() => castView(view.cast), [view.cast])
  const kindRoot = kindRootProps(useChatKindLook(view.chat?.kind))
  // Back and Forward move the branch shown; a switch made here has moved it already.
  const shownFork = useRef(fork)
  useEffect(() => {
    if (shownFork.current === fork) return
    shownFork.current = fork
    session.showFork(fork, null)
  }, [session, fork])
  useEffect(() => {
    if (view.deleted) onGone()
  }, [view.deleted, onGone])
  const [branchError, setBranchError] = useState<string | null>(null)
  const onBranch = useCallback(
    async (entry: PathEntry, index: number) => {
      const result = await session.switchBranch(entry, index)
      if (!result.ok) return setBranchError(result.error.message)
      setBranchError(null)
      const target = result.value.fork.id
      shownFork.current = target === result.value.chat.currentForkId ? null : target
      session.showFork(target, result.value.slotId)
      onFork(shownFork.current ?? "")
    },
    [session, onFork]
  )
  const switchBranch = useCallback((entry: PathEntry, index: number) => void onBranch(entry, index), [onBranch])
  const noSummaries = useCallback(() => {}, [])
  // Its settings and other panels are in its own tab: this one's panel is the story's.
  const openPanel = useCallback(
    (tab: string | null) => {
      if (tab !== null) open(`/chats/${session.id}?panel=${encodeURIComponent(tab)}`)
    },
    [open, session.id]
  )
  const problem = error ?? view.error ?? branchError
  return (
    <ChatPlaceScope value={SIDE_CHAT_SCOPE}>
      <ChatSurfaceProviders
        session={session}
        cast={cast}
        view={view}
        wide={false}
        onOpenPanel={openPanel}
        except={PAGE_PROVIDERS}
      >
        <CastContext value={cast}>
          <div
            {...kindRoot}
            data-side-chat={session.id}
            // A container, so its messages' headers wrap at the panel's width as on a phone.
            className="@container/chat flex min-h-0 flex-1 flex-col"
            style={{ ...kindRoot.style, "--chat-portrait-width": "48px" } as CSSProperties}
          >
            {header}
            {problem && (
              <div className="px-3 pt-2">
                <Alert tone="danger">{problem}</Alert>
              </div>
            )}
            {view.loading ? (
              <SkeletonMessages onRetry={() => void session.open(null)} />
            ) : (
              <MessageList
                embedded
                session={session}
                view={view}
                anchor={null}
                jump={null}
                flashes={flashes}
                restore={null}
                rail={false}
                onBranch={switchBranch}
                onOpenSummaries={noSummaries}
              />
            )}
            <SlotOutlet slot={chatComposerNotes} props={{ view }} />
            <SlotOutlet slot={chatComposer} props={{ session, view, onSettings: openPanel }} />
            <SlotOutlet slot={chatOverlays} props={{ session, view }} />
          </div>
        </CastContext>
      </ChatSurfaceProviders>
    </ChatPlaceScope>
  )
}
