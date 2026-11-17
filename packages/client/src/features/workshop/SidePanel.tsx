// The workshop beside a story (spec/WORKSHOP.md §4, W9): the story's Workshop tab shows a whole
// workshop chat, its messages and its composer, at the panel's width. It's a chat of its own: its
// own session and event stream, its own branch (`side.fork`) and dialogs (`side.messageDialog`)
// in the URL, so neither chat moves or opens anything in the other. The assistant reads the story
// through its story tools, at the branch and newest message this tab shows (`storyAt`, sent with
// each request from here); nothing said here is in the story's context.
import type { Chat, ChatId, ForkId, PathEntry, StoryAt } from "@rp/shared/chat.ts"
import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useNavigate, useSearch } from "@tanstack/react-router"
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
import { AppClient } from "../../rpc.ts"
import { useSession } from "../../session.ts"
import { ChangesPanel } from "./ChangesPanel.tsx"
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
import { branchLabel, useChatForks } from "../chat/forks.ts"
import { ReplyExtrasContext, type ReplyExtrasSource } from "../chat/replyExtras.ts"
import { SkeletonMessages } from "../chat/SkeletonMessages.tsx"
import { useCanOpenBeside } from "../workbench/OpenBeside.tsx"
import { useOpenBesideThis } from "./storyLink.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { PendingSideChat } from "./PendingSideChat.tsx"
import {
  chooseSideChat,
  NEW_SIDE_CHAT,
  sideChatSearch,
  SIDE_CHAT_PARAM,
  SIDE_CHAT_SCOPE,
  SIDE_CHATS_KEY
} from "./sideChat.ts"

const attachedTo = Atom.family((chatId: ChatId) =>
  AppClient.query("ListAttachedWorkshops", { chatId }, { reactivityKeys: [SIDE_CHATS_KEY, chatId] })
)

/** The page's own: the portrait column and the editor tabs' workspace stay the story's. */
const PAGE_PROVIDERS: ReadonlySet<string> = new Set(["chat.portraits", "chat.preset-workspace"])

/** An older window can end before the branch's tip; don't read the unseen tail. */
const shownStoryLeaf = (view: ChatView) =>
  view.newer != null ? (view.entries.at(-1)?.slotId ?? null) : view.leafSlotId

/** Where this tab shows the story, read at the moment of each request; none before it's open. */
export const storyPosition = (story: ChatSession): StoryAt | undefined => {
  const view = story.snapshot()
  const forkId = view.forkId ?? view.chat?.currentForkId ?? null
  if (view.loading || view.chat === null || forkId === null) return undefined
  return { chatId: story.id, forkId, leafSlotId: shownStoryLeaf(view) }
}

/** "Reads “Original”, up to message 12": the branch and message the next request reads to. */
function ReadingLine({ story, view }: { story: ChatSession; view: ChatView }) {
  const { shown } = useChatForks(story, view)
  const leaf = view.entries.find((e) => e.slotId === shownStoryLeaf(view))
  const upTo = leaf ? (leaf.position ?? leaf.depth) + 1 : null
  return (
    <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted" data-side-chat-reading="">
      Reads {shown ? <span className="font-medium text-text">“{branchLabel(shown)}”</span> : "this branch"}
      {upTo !== null ? `, up to message ${upTo}` : ""}. Regenerate uses this position; Resume needs the original
      position.
    </p>
  )
}

/** Opens the workshop beside the story, never in its place (owner, 2026-11-17): storyLink.tsx. */
const useOpenOwn = () => useOpenBesideThis().open

export function WorkshopSidePanel(props: PanelProps) {
  return props.active ? <ActiveWorkshopSidePanel {...props} /> : null
}

function ActiveWorkshopSidePanel({ session, view: storyView }: PanelProps) {
  const atom = attachedTo(session.id)
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const wanted = typeof search[SIDE_CHAT_PARAM] === "string" ? (search[SIDE_CHAT_PARAM] as string) : ""
  const setWanted = useCallback(
    (id: string, replace = false) => {
      void navigate({
        to: ".",
        search: (previous: Record<string, unknown>) => sideChatSearch(previous, id),
        state: (previous) => ({ ...previous }),
        replace,
        resetScroll: false
      })
    },
    [navigate]
  )
  // The workshop the composer's first send just made: shown at once, before the list read again
  // has it and while the URL moves to it, so nothing else shows in between.
  const [created, setCreated] = useState<{ readonly chat: Chat; readonly moving: boolean } | null>(null)
  const read = AsyncResult.isSuccess(result) ? result.value : null
  const list = useMemo(
    () =>
      read === null || created === null || read.some((chat) => chat.id === created.chat.id)
        ? read
        : [created.chat, ...read],
    [read, created]
  )
  const choice = list === null ? null : chooseSideChat(list, created?.moving ? created.chat.id : wanted || null)
  // Once the URL names it, and then once the list has it, it's shown as any other.
  if (created?.moving && wanted === created.chat.id) setCreated({ chat: created.chat, moving: false })
  else if (created && !created.moving && read?.some((chat) => chat.id === created.chat.id)) setCreated(null)
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
  const gone = useCallback(() => {
    setWanted("", true)
    refresh()
  }, [setWanted, refresh])
  // Where the story is read for a reply, at the moment of each request.
  const extras = useMemo<ReplyExtrasSource>(
    () => () => {
      const storyAt = storyPosition(session)
      return storyAt ? { storyAt } : {}
    },
    [session]
  )
  // The workshop the first send made: its composer is ready to go on, as the one typed in was.
  const [focusMade, setFocusMade] = useState<ChatId | null>(null)
  const onCreated = useCallback(
    (chat: Chat) => {
      setCreated({ chat, moving: true })
      setFocusMade(chat.id)
      setWanted(chat.id, true)
    },
    [setWanted]
  )

  if (AsyncResult.isFailure(result) && list === null)
    return (
      <div className="px-4 py-4">
        <Alert tone="danger">The workshops beside this chat couldn’t be read.</Alert>
      </div>
    )
  if (choice === null || missing) return <p className="px-4 py-4 text-sm text-muted">Loading the workshop…</p>
  const header = (
    <>
      <SideChatHeader
        shown={choice.shown}
        all={list ?? []}
        onPick={(id) => {
          setFocusMade(null)
          setWanted(id)
        }}
        onNew={() => {
          setFocusMade(null)
          setWanted(NEW_SIDE_CHAT)
        }}
      />
      <ReadingLine story={session} view={storyView} />
    </>
  )
  // None yet, or a new one: its composer, ready; the first send makes it.
  if (choice.shown === null)
    return <PendingSideChat key="new" story={session} storyAt={extras} header={header} onCreated={onCreated} />
  return (
    <SideChat
      key={choice.shown.id}
      chat={choice.shown}
      extras={extras}
      focusComposer={focusMade === choice.shown.id}
      header={header}
      onGone={gone}
    />
  )
}

/** The header: the workshop shown (`null`: one not made yet), the others beside this chat, a new one. */
function SideChatHeader({
  shown,
  all,
  onPick,
  onNew
}: {
  shown: Chat | null
  all: ReadonlyArray<Chat>
  onPick: (id: ChatId) => void
  onNew: () => void
}) {
  const open = useOpenOwn()
  const wide = useCanOpenBeside()
  const href = shown === null ? null : `/chats/${shown.id}`
  const title = shown?.title ?? "New workshop"
  const [panel, setPanel] = usePlaceParam(chatPlaceKey(SIDE_CHAT_SCOPE, "panel"), "")
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
      <KindBadge kind="workshop" />
      {all.length === 0 ? (
        <span data-layout-name className="min-w-0 flex-1 truncate px-1.5 py-1 text-sm font-medium">
          {title}
        </span>
      ) : (
        <Menu
          label="Workshops beside this chat"
          align="start"
          hint="Switches to another workshop beside this chat, or starts a new one."
          trigger={
            <button
              type="button"
              aria-label={`Workshop: ${title}`}
              className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-sm font-medium hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus outline-none"
            >
              <span data-layout-name className="min-w-0 truncate">
                {title}
              </span>
              <Icon name="down" className="shrink-0 text-muted" />
            </button>
          }
        >
          {all.map((chat) => (
            <MenuItem
              key={chat.id}
              {...(chat.id === shown?.id ? { icon: "check" as const } : {})}
              description={chat.id === shown?.id ? "Shown now." : "Shows this workshop here instead."}
              onClick={() => onPick(chat.id)}
            >
              {chat.title}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem
            icon={shown === null ? "check" : "plus"}
            description={
              shown === null
                ? "Shown now: your first message starts it."
                : "Opens a new workshop beside this chat; your first message starts it."
            }
            onClick={onNew}
          >
            New workshop
          </MenuItem>
        </Menu>
      )}
      {shown !== null && href !== null && (
        <>
          <Button
            variant="ghost"
            className="shrink-0 px-2 text-xs"
            aria-pressed={panel === "workshop.changes"}
            hint={
              panel === "workshop.changes"
                ? "Returns to this workshop’s conversation."
                : "Shows what this workshop changed, with Undo."
            }
            onClick={() => setPanel(panel === "workshop.changes" ? "" : "workshop.changes")}
          >
            Changes
          </Button>
          <IconLink
            label="Open beside the story"
            hint={
              wide
                ? "Opens this workshop beside the story, in its own pane."
                : "Opens this workshop on its own page. Back returns to the story."
            }
            icon="external"
            href={href}
            onOpen={() => open(href)}
          />
        </>
      )}
    </div>
  )
}

/** One workshop beside the story: its own session, at the panel's width. */
function SideChat({
  chat,
  extras,
  focusComposer,
  header,
  onGone
}: {
  chat: Chat
  /** Where the story beside it is read for each reply request (`storyPosition`). */
  extras: ReplyExtrasSource
  /** Just made by the composer's first send: its composer takes the focus the first one had. */
  focusComposer: boolean
  header: ReactNode
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
    next.setReplyExtras(extras)
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
  }, [chat.id, opening, registry, userId, extras])
  if (session === null || session.id !== chat.id)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <p className="px-4 py-4 text-sm text-muted">Loading the workshop…</p>
      </div>
    )
  return (
    <ReplyExtrasContext value={extras}>
      <SideChatSurface
        session={session}
        fork={fork}
        onFork={setUrlFork}
        header={header}
        focusComposer={focusComposer}
        onGone={onGone}
      />
    </ReplyExtrasContext>
  )
}

function SideChatSurface({
  session,
  fork,
  onFork,
  header,
  focusComposer,
  onGone
}: {
  session: ChatSession
  fork: ForkId | null
  onFork: (fork: string) => void
  header: ReactNode
  focusComposer: boolean
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
  const [sidePanel] = usePlaceParam(chatPlaceKey(SIDE_CHAT_SCOPE, "panel"), "")
  const changes = sidePanel === "workshop.changes"
  const problem = view.error ?? branchError
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focusComposer)
      root.current?.querySelector<HTMLElement>('[data-testid="composer"]')?.focus({ preventScroll: true })
  }, [focusComposer])
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
            ref={root}
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
            {changes ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-3" data-side-chat-changes="">
                <ChangesPanel session={session} view={view} active />
              </div>
            ) : view.loading ? (
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
            {!changes && (
              <>
                <SlotOutlet slot={chatComposerNotes} props={{ view, session }} />
                <SlotOutlet slot={chatComposer} props={{ session, view, onSettings: openPanel }} />
              </>
            )}
            <SlotOutlet slot={chatOverlays} props={{ session, view }} />
          </div>
        </CastContext>
      </ChatSurfaceProviders>
    </ChatPlaceScope>
  )
}
