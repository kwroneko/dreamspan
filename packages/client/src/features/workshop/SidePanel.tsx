// The workshop beside a story (spec/WORKSHOP.md §4, W9): the story's Workshop tab shows a whole
// workshop chat, its messages and its composer, at the panel's width. It's a chat of its own: its
// own session and event stream, its own branch (`side.fork`) and dialogs (`side.messageDialog`)
// in the URL, so neither chat moves or opens anything in the other. It follows the story branch
// shown: it lists the workshops with a branch going with it and shows that branch
// (spec/WORKSHOP-BRANCHES.md §8.1). The assistant reads the story through its story tools, where
// the server places each reply (the paired story branch); nothing said here is in the story's context.
import type { Chat, ChatId, ForkId, PathEntry } from "@dreamspan/shared/chat.ts"
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
import { composerTextbox } from "../chat/composerFocus.ts"
import { type Flashes, MessageList } from "../chat/ChatPage.tsx"
import { KindBadge } from "../chat/KindBadge.tsx"
import { kindRootProps, useChatKindLook } from "../chat/kindLooks.ts"
import type { PanelProps } from "../chat/panels.tsx"
import { ChatSurfaceProviders, chatComposer, chatComposerNotes, chatOverlays } from "../chat/presentation.tsx"
import { ChatSession, type ChatView, seedChat } from "../chat/session.ts"
import { branchLabel, useChatForks } from "../chat/forks.ts"
import { SkeletonMessages } from "../chat/SkeletonMessages.tsx"
import { useCanOpenBeside } from "../workbench/OpenBeside.tsx"
import { useOpenBesideThis } from "./storyLink.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { PendingSideDraft, type SideDraftHost } from "./PendingSideDraft.tsx"
import { pairedWith, useWorkshopBranches } from "./workshopBranches.tsx"
import type { WorkshopBranch } from "@dreamspan/shared/workshopApi.ts"
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
/** Those with a branch going with one story branch (key: `chatId forkId`). */
const besideBranch = Atom.family((key: string) => {
  const [chatId, forkId] = key.split(" ") as [ChatId, ForkId]
  return AppClient.query("ListAttachedWorkshops", { chatId, forkId }, { reactivityKeys: [SIDE_CHATS_KEY, chatId] })
})

/** The page's own: the portrait column and the editor tabs' workspace stay the story's. */
const PAGE_PROVIDERS: ReadonlySet<string> = new Set(["chat.portraits", "chat.preset-workspace"])

/** "Reads “Original”, up to message 12": the story branch shown, which its replies read, to its end. */
function ReadingLine({ story, view }: { story: ChatSession; view: ChatView }) {
  const { shown } = useChatForks(story, view)
  const tip = view.newer == null ? view.entries.at(-1) : undefined
  const upTo = tip ? (tip.position ?? tip.depth) + 1 : null
  return (
    <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted" data-side-chat-reading="">
      Reads {shown ? <span className="font-medium text-text">“{branchLabel(shown)}”</span> : "this branch"}
      {upTo !== null ? `, up to message ${upTo}` : ""}.
    </p>
  )
}

/** Opens the workshop beside the story, never in its place (owner, 2026-11-17): storyLink.tsx. */
const useOpenOwn = () => useOpenBesideThis().open

export function WorkshopSidePanel(props: PanelProps) {
  return props.active ? <ActiveWorkshopSidePanel {...props} /> : null
}

function ActiveWorkshopSidePanel({ session, view: storyView }: PanelProps) {
  // The story branch shown: the tab lists and shows what goes with it.
  const storyFork = storyView.forkId ?? storyView.chat?.currentForkId ?? null
  const all = useAtomValue(attachedTo(session.id))
  const refreshAll = useAtomRefresh(attachedTo(session.id))
  const atom = besideBranch(`${session.id} ${storyFork ?? ""}`)
  const result = useAtomValue(atom)
  const refreshBeside = useAtomRefresh(atom)
  const refresh = useCallback(() => {
    refreshAll()
    refreshBeside()
  }, [refreshAll, refreshBeside])
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
  // One beside the story but with no branch going with the shown one isn't gone: the tab shows
  // this branch's default instead, and the URL keeps naming it for the branch that has it. (Until
  // the whole list is read, it isn't taken as gone either.)
  const elsewhere =
    wanted !== "" &&
    wanted !== NEW_SIDE_CHAT &&
    !(list ?? []).some((chat) => chat.id === wanted) &&
    (!AsyncResult.isSuccess(all) || all.value.some((chat) => chat.id === wanted))
  const choice =
    list === null ? null : chooseSideChat(list, created?.moving ? created.chat.id : elsewhere ? null : wanted || null)
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
  // None yet, or a new one: a pending workshop shown as a saved one is; its first send starts it.
  if (choice.shown === null)
    return (
      <PendingSideDraft
        key={`new ${storyFork ?? ""}`}
        story={session.id}
        storyFork={storyFork}
        header={header}
        onCreated={onCreated}
        onGone={gone}
        Surface={PendingSideSurface}
      />
    )
  return (
    <SideChat
      key={choice.shown.id}
      chat={choice.shown}
      storyFork={storyFork}
      focusComposer={focusMade === choice.shown.id}
      header={header}
      onGone={gone}
    />
  )
}

/** A workshop not started yet, in the tab's own chat surface. */
function PendingSideSurface({
  chat,
  draft,
  storyFork,
  header,
  onGone
}: {
  chat: Chat
  draft: SideDraftHost
  storyFork: ForkId | null
  header: ReactNode
  onGone: () => void
}) {
  return (
    <SideChat chat={chat} storyFork={storyFork} focusComposer={false} header={header} onGone={onGone} draft={draft} />
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
          label="Workshops beside this branch"
          align="start"
          hint="Switches to another workshop beside this branch of the story, or starts a new one."
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
                : "Opens a new workshop beside this branch of the story; your first message starts it."
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
  storyFork,
  focusComposer,
  header,
  onGone,
  draft
}: {
  chat: Chat
  /** The story branch shown: the workshop shows a branch of its own that goes with it. */
  storyFork: ForkId | null
  /** Just made by the composer's first send: its composer takes the focus the first one had. */
  focusComposer: boolean
  header: ReactNode
  onGone: () => void
  /** A workshop not started yet (PendingSideDraft): told when its first turn starts it. */
  draft?: SideDraftHost
}) {
  const registry = useContext(RegistryContext)
  const userId = useSession().user.id
  const forkKey = chatPlaceKey(SIDE_CHAT_SCOPE, "fork")
  const [urlFork, setUrlFork] = usePlaceParam(forkKey, "")
  // The URL's branch while it goes with the story branch shown, else the one of those chatted in
  // last (spec/WORKSHOP-BRANCHES.md §8.1).
  const branches = useWorkshopBranches(chat.id, storyFork, "story")
  const beside = branches === null ? [] : pairedWith(branches, storyFork)
  const fork = (beside.find((branch) => branch.forkId === urlFork) ?? beside[0])?.forkId
  // Opened once on that branch; later the branch shown moves this session (Back, Forward, a story
  // branch switch) rather than starting another.
  const [opening, setOpening] = useState<ForkId | null>(null)
  if (opening === null && fork !== undefined) setOpening(fork)
  const [session, setSession] = useState<ChatSession | null>(null)
  useLayoutEffect(() => {
    if (opening === null) return
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
  if (session === null || session.id !== chat.id || fork === undefined)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <p className="px-4 py-4 text-sm text-muted">Loading the workshop…</p>
      </div>
    )
  return (
    <SideChatSurface
      session={session}
      fork={fork}
      beside={beside}
      onFork={setUrlFork}
      header={header}
      focusComposer={focusComposer}
      onGone={onGone}
      draft={draft ?? null}
    />
  )
}

function SideChatSurface({
  session,
  fork,
  beside,
  onFork,
  header,
  focusComposer,
  onGone,
  draft
}: {
  session: ChatSession
  fork: ForkId
  /** Its branches going with the story branch shown, last chatted in first. */
  beside: ReadonlyArray<WorkshopBranch>
  onFork: (fork: string) => void
  header: ReactNode
  focusComposer: boolean
  onGone: () => void
  draft: SideDraftHost | null
}) {
  const view: ChatView = useSyncExternalStore(session.subscribe, session.snapshot)
  // A new workshop's first turn started it: the tab shows it as any other, opening on what this
  // shows, with no loading state in between.
  const started = view.chat !== null && view.chat.status !== "pending"
  useEffect(() => {
    if (draft === null || !started) return
    const now = session.snapshot()
    if (now.chat === null) return
    seedChat(now.chat.id, {
      chat: now.chat,
      forkId: now.forkId,
      leafSlotId: now.leafSlotId,
      entries: now.entries,
      older: now.older,
      newer: now.newer,
      cast: now.cast
    })
    draft.onStarted(now.chat)
  }, [draft, started, session])
  const open = useOpenOwn()
  const flashes = useRef<Flashes>({ opened: 0, repeat: null })
  const cast = useMemo(() => castView(view.cast), [view.cast])
  const kindRoot = kindRootProps(useChatKindLook(view.chat?.kind))
  // Back and Forward move the branch shown; a switch made here has moved it already.
  const shownFork = useRef(view.forkId)
  useEffect(() => {
    if (shownFork.current === fork) return
    shownFork.current = fork
    session.showFork(fork, null)
  }, [session, fork])
  useEffect(() => {
    if (!view.deleted) return
    if (draft !== null) draft.onDeleted()
    else onGone()
  }, [view.deleted, onGone, draft])
  const [branchError, setBranchError] = useState<string | null>(null)
  const onBranch = useCallback(
    async (entry: PathEntry, index: number) => {
      const result = await session.switchBranch(entry, index)
      if (!result.ok) return setBranchError(result.error.message)
      setBranchError(null)
      const target = result.value.fork.id
      shownFork.current = target
      session.showFork(target, result.value.slotId)
      onFork(target)
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
    if (focusComposer) (root.current ? composerTextbox(root.current) : null)?.focus({ preventScroll: true })
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
            {beside.length > 1 && (
              <SideBranchMenu session={session} view={view} beside={beside} shown={fork} onPick={onFork} />
            )}
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
            {!changes && !view.loading && view.forkId === fork && (
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

/**
 * The workshop's branches that go with the story branch shown (§8.3): beside a story, the side
 * chat never shows talk about another story branch. Shown once there's more than one.
 */
function SideBranchMenu({
  session,
  view,
  beside,
  shown,
  onPick
}: {
  session: ChatSession
  view: ChatView
  beside: ReadonlyArray<WorkshopBranch>
  shown: ForkId | null
  onPick: (fork: string) => void
}) {
  const { forks } = useChatForks(session, view)
  const label = (forkId: ForkId) => {
    const fork = forks?.find((f) => f.id === forkId)
    return fork ? branchLabel(fork) : "Branch"
  }
  const current = shown ?? beside[0]?.forkId ?? null
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2" data-side-chat-branches="">
      <Menu
        label="Workshop branches for this story branch"
        align="start"
        hint="Each branch of this workshop goes with one branch of the story. These go with the one shown."
        trigger={
          <button
            type="button"
            aria-label={`Workshop branch: ${current ? label(current) : "Branch"}, 1 of ${beside.length}: switch branch`}
            className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-xs text-muted hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus outline-none"
          >
            <Icon name="branch" className="shrink-0" />
            <span data-layout-name className="min-w-0 truncate">
              {current ? label(current) : "Branch"}
            </span>
            <Icon name="down" className="shrink-0" />
          </button>
        }
      >
        {beside.map((branch) => (
          <MenuItem
            key={branch.forkId}
            {...(branch.forkId === current ? { icon: "check" as const } : {})}
            description={branch.forkId === current ? "Shown now." : "Shows this branch of the workshop here."}
            onClick={() => onPick(branch.forkId)}
          >
            {label(branch.forkId)}
          </MenuItem>
        ))}
      </Menu>
    </div>
  )
}
