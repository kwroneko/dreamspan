// The new-chat pages (DESIGN §2.1, owner 2026-11-23): a new chat with a card
// (`/cards/$entityId/chat`), a group's (`/groups/$chatId/new`) or one with nobody in it yet
// (`/new/chat`) is a real chat, pending until its first turn (the server's `OpenDraftChat`),
// shown by the chat page itself: its greetings are messages, its composer, panels and request
// inspector the saved chat's. Nothing lists it and it changes nothing until it is started, so a
// page left behind leaves nothing (the server sweeps it, its typing to recovered texts).
//
// The URL keeps `?draft=<id>`, so a reload reopens the same chat; each fresh visit draws its
// greetings afresh. Once its first turn started it, the URL becomes the chat's own, in place.
import type { Chat, ChatId, EntityId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import type { DraftFor } from "@dreamspan/shared/draftChatApi.ts"
import { useNavigate, useParams, useSearch } from "@tanstack/react-router"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { type ActionResult, ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { useCaller } from "../editor/caller.ts"
import { EMPTY_CHAT_TITLE } from "./ChatsPage.tsx"
import { useTitle } from "../shell.tsx"
import { type DraftHost, OpenChat } from "./ChatPage.tsx"
import { preloadChatPage } from "./chatPageLoader.ts"
import { useIsPanelTab } from "./panels.tsx"
import { carryPanelFocus } from "./ChatPanels.tsx"
import { seedChat } from "./session.ts"
import { carryLeftover, fileLeftover } from "./composerDraft.ts"
import { rememberDraftFor, rememberReplaced, reopenSweptDraft } from "./chatStarted.ts"
import { ChatSkeleton } from "./SkeletonMessages.tsx"
import { FinishMeantTitle, meantTitle } from "./meantTitle.tsx"

/** The search param naming the page's pending chat, so a reload reopens it. */
export const DRAFT_PARAM = "draft"

/** One open per page and attempt, even when React runs the effect twice. */
const opening = new Map<string, Promise<ActionResult<Chat>>>()

type DraftSearch = (search: Record<string, unknown>, chatId: ChatId) => Record<string, unknown>

function DraftChat({
  draftFor,
  onOpened,
  prepareSearch
}: {
  draftFor: DraftFor
  /** A pending chat was opened for the page: a fresh one, or (`reopened`) the one its URL named. */
  onOpened?: ((chat: Chat, reopened: boolean) => void) | undefined
  prepareSearch?: DraftSearch | undefined
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const named =
    typeof search[DRAFT_PARAM] === "string" && search[DRAFT_PARAM] !== "" ? (search[DRAFT_PARAM] as ChatId) : null
  const navigate = useNavigate()
  const action = useAction()
  const call = useCaller()
  const [chat, setChat] = useState<Chat | null>(null)
  const [attempt, setAttempt] = useState(0)
  // The chat the URL named when the page opened: a later catch-up of the URL opens nothing.
  // After a sweep, a workshop names its predecessor so the writer can recover attachments.
  const [reopen, setReopen] = useState(named)
  const started = useRef(false)
  // Opening another after the shown one was deleted.
  const replacing = useRef(false)
  // The chat shown, for what its composer has left when another replaces it.
  const shownId = useRef<ChatId | null>(null)
  useEffect(() => {
    shownId.current = chat?.id ?? null
  }, [chat])
  useEffect(preloadChatPage, [])
  useEffect(() => {
    let live = true
    const key = `${draftFor}:${reopen ?? ""}:${attempt}`
    const run =
      opening.get(key) ??
      action.run((client) => client("OpenDraftChat", { draftFor, ...(reopen === null ? {} : { reopen }) }))
    opening.set(key, run)
    void run.then((opened) => {
      opening.delete(key)
      if (!live) return
      // The old chat is gone. If opening its replacement fails, show the error and Try again.
      if (!opened.ok) {
        if (replacing.current) setChat(null)
        return
      }
      const value = opened.value
      // What was typed in the swept chat after its saving stopped goes on in this one.
      if (replacing.current && shownId.current !== null) carryLeftover(shownId.current, value.id)
      // The chat this one takes the place of: swept while shown, or before a reload.
      const replaced = replacing.current ? shownId.current : reopen !== null && value.id !== reopen ? reopen : null
      replacing.current = false
      // The chat the URL names was started meanwhile (in another tab, say): it's that chat now.
      if (value.status !== "pending") {
        started.current = true
        void navigate({
          to: "/chats/$chatId",
          params: { chatId: value.id },
          search: ({ [DRAFT_PARAM]: _draft, ...prev }: Record<string, unknown>) => prev,
          replace: true
        })
        return
      }
      rememberDraftFor(value.id, draftFor)
      if (replaced !== null) rememberReplaced(value.id, replaced)
      setChat(value)
      // A reopened one too: a reload before the rename this tab meant for it still names it.
      onOpened?.(value, value.id === reopen)
      if (value.id !== reopen)
        void navigate({
          to: ".",
          search: (prev: Record<string, unknown>) => ({
            ...(prepareSearch?.(prev, value.id) ?? prev),
            [DRAFT_PARAM]: value.id
          }),
          replace: true,
          resetScroll: false
        })
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per entry and attempt
  }, [draftFor, reopen, attempt])
  // The tab was sent to another of this entry's new chats (a workbench tab keeps its page, by
  // path): that one opens here, rather than the composer staying on the first.
  const [followed, setFollowed] = useState(named)
  if (named !== followed) {
    setFollowed(named)
    if (named !== null && chat !== null && named !== chat.id) {
      setChat(null)
      setReopen(named)
    }
  }
  // Leaving the page leaves its chat: the server sweeps it unless another tab has it open.
  const chatId = chat?.id ?? null
  useEffect(() => {
    if (chatId === null) return
    return () => {
      if (!started.current) void call((client) => client("LeaveDraftChat", { chatId }))
      // Typed after the chat was swept and not carried into another: filed to the recovered
      // texts once, as the sweep filed the rest.
      fileLeftover(chatId, (save) => call((client) => client("SaveComposer", save)))
    }
  }, [chatId, call])
  // A new chat asked for with Guidance on (New chat with this cast) starts with it on, once.
  const [guidance] = useState(search.guidance === "on" && named === null)
  const host = useMemo<DraftHost>(
    () => ({
      guidance,
      onStarted: (view) => {
        if (started.current || view.chat === null) return
        started.current = true
        // The chat's own page opens on what this one shows, with no loading state in between.
        seedChat(view.chat.id, {
          chat: view.chat,
          forkId: view.forkId,
          leafSlotId: view.leafSlotId,
          entries: view.entries,
          older: view.older,
          newer: view.newer,
          cast: view.cast
        })
        // Focus on the panel's tabs stays on the same tab of the chat's own page.
        carryPanelFocus(view.chat.id, Boolean(document.activeElement?.closest("[data-chat-panel-tabs]")))
        void navigate({
          to: "/chats/$chatId",
          params: { chatId: view.chat.id },
          search: ({ [DRAFT_PARAM]: _draft, ...prev }: Record<string, unknown>) => prev,
          replace: true,
          resetScroll: false
        })
      },
      onDeleted: () => {
        if (started.current) return
        // Swept while open (no tab had it for a while; a reconnect after a long sleep, say): a
        // fresh one for the same entry, with no notice. The chat shown stays until it's here.
        replacing.current = true
        setReopen(reopenSweptDraft(draftFor, shownId.current))
        setAttempt((n) => n + 1)
      }
    }),
    [navigate, guidance, draftFor]
  )
  const fork = typeof search.fork === "string" && search.fork !== "" ? (search.fork as ForkId) : null
  const slot = typeof search.slot === "string" ? (search.slot as SlotId) : null
  const validPanel = useIsPanelTab(search.panel)
  const panel = validPanel ? (search.panel as string) : null
  if (chat !== null) return <OpenChat chatId={chat.id} fork={fork} slot={slot} panel={panel} draft={host} />
  return action.error ? (
    <div className="chat-column pt-4">
      <ErrorAlert
        error={action.error}
        actions={
          <Button
            hint="Retries opening the new chat."
            variant="ghost"
            onClick={() => {
              action.clearError()
              setAttempt((n) => n + 1)
            }}
          >
            Try again
          </Button>
        }
      />
    </div>
  ) : (
    // The chat page's own loading state, so nothing moves as the chat comes.
    <ChatSkeleton onRetry={() => setAttempt((n) => n + 1)} />
  )
}

function DraftChatPage({
  draftFor,
  onOpened,
  prepareSearch,
  pageTitle = "New chat"
}: {
  draftFor: DraftFor
  onOpened?: (chat: Chat, reopened: boolean) => void
  prepareSearch?: DraftSearch | undefined
  pageTitle?: string
}) {
  useTitle(pageTitle)
  return (
    <div data-fill className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Another entry is another chat. */}
      <DraftChat key={draftFor} draftFor={draftFor} onOpened={onOpened} prepareSearch={prepareSearch} />
    </div>
  )
}

/** /cards/$entityId/chat: a new chat with a card. */
export function CardDraftChatPage() {
  const { entityId } = useParams({ strict: false }) as { entityId: EntityId }
  return <CardDraftChat entityId={entityId} />
}

/** A new chat with a card of the user's, wherever its page is (a card source's card they hold, too). */
export function CardDraftChat({ entityId }: { entityId: EntityId }) {
  return <DraftChatPage draftFor={`card:${entityId}`} />
}

/** /groups/$chatId/new: a new chat with a group's characters, one of the group's chats. */
export function GroupDraftChatPage() {
  const { chatId } = useParams({ strict: false }) as { chatId: ChatId }
  return <DraftChatPage draftFor={`group:${chatId}`} />
}

/** /new/chat: a chat with nobody in it yet (the Chats page's New chat). */
export function EmptyDraftChatPage() {
  return <TitledDraftChatPage draftFor="empty" titleKey={EMPTY_CHAT_TITLE} />
}

/**
 * A new chat named by the title typed on the Chats page's start card (`titleKey`, its user
 * draft): a rename, which starts nothing; the title's draft ends once it's the chat's. A chat
 * started before the rename was seen through gets it on its own page (meantTitle.tsx).
 */
export function TitledDraftChatPage({
  draftFor,
  titleKey,
  pageTitle,
  prepareSearch
}: {
  draftFor: DraftFor
  titleKey: string
  pageTitle?: string
  prepareSearch?: DraftSearch
}) {
  const [opened, setOpened] = useState<ChatId | null>(null)
  // The name given, once read: a fresh chat opened after a sweep gets it too.
  const named = useRef<string | null>(null)
  const onOpened = useCallback(
    (chat: Chat, reopened: boolean) => {
      // Kept before the URL names the chat: a reload at once still names it as meant. A chat its
      // URL named takes only the rename this tab meant for it and hadn't seen through (a reload
      // before it), never what the start card holds now: that's for the next new chat.
      if (!reopened && meantTitle(chat.id) === null)
        meantTitle(chat.id, { name: named.current, from: chat.title, titleKey })
      setOpened(chat.id)
    },
    [titleKey]
  )
  const onNamed = useCallback((name: string) => {
    named.current ??= name
  }, [])
  return (
    <>
      <FinishMeantTitle chatId={opened} titleKey={titleKey} onNamed={onNamed} />
      <DraftChatPage
        draftFor={draftFor}
        onOpened={onOpened}
        prepareSearch={prepareSearch}
        {...(pageTitle === undefined ? {} : { pageTitle })}
      />
    </>
  )
}
