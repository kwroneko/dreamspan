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
import { useEffect, useMemo, useRef, useState } from "react"
import { type ActionResult, ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { useCaller } from "../editor/caller.ts"
import { useUserDraft } from "../editor/userDraft.tsx"
import { EMPTY_CHAT_TITLE } from "./ChatsPage.tsx"
import { useTitle } from "../shell.tsx"
import { type DraftHost, OpenChat } from "./ChatPage.tsx"
import { preloadChatPage } from "./chatPageLoader.ts"
import { useIsPanelTab } from "./panels.tsx"
import { carryPanelFocus } from "./ChatPanels.tsx"
import { seedChat } from "./session.ts"
import { rememberDraftFor } from "./chatStarted.ts"
import { ChatSkeleton } from "./SkeletonMessages.tsx"

/** The search param naming the page's pending chat, so a reload reopens it. */
export const DRAFT_PARAM = "draft"

/** One open per page and attempt, even when React runs the effect twice. */
const opening = new Map<string, Promise<ActionResult<Chat>>>()

function DraftChat({
  draftFor,
  onOpened
}: {
  draftFor: DraftFor
  /** A fresh pending chat was opened for the page (not one its URL named). */
  onOpened?: ((chat: Chat) => void) | undefined
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
  // Null once the server swept it, so the next attempt opens a fresh one.
  const [reopen, setReopen] = useState(named)
  const started = useRef(false)
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
      if (!live || !opened.ok) return
      const value = opened.value
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
      setChat(value)
      if (value.id !== reopen) onOpened?.(value)
      if (value.id !== reopen)
        void navigate({
          to: ".",
          search: (prev: Record<string, unknown>) => ({ ...prev, [DRAFT_PARAM]: value.id }),
          replace: true,
          resetScroll: false
        })
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per entry and attempt
  }, [draftFor, reopen, attempt])
  // Leaving the page leaves its chat: the server sweeps it unless another tab has it open.
  const chatId = chat?.id ?? null
  useEffect(() => {
    if (chatId === null) return
    return () => {
      if (!started.current) void call((client) => client("LeaveDraftChat", { chatId }))
    }
  }, [chatId, call])
  const host = useMemo<DraftHost>(
    () => ({
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
        setReopen(null)
        setAttempt((n) => n + 1)
      }
    }),
    [navigate]
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

function DraftChatPage({ draftFor, onOpened }: { draftFor: DraftFor; onOpened?: (chat: Chat) => void }) {
  useTitle("New chat")
  return (
    <div data-fill className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Another entry is another chat. */}
      <DraftChat key={draftFor} draftFor={draftFor} onOpened={onOpened} />
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
  // The title typed on the Chats page's start card names the chat it opens (a rename, which
  // starts nothing); the title's draft ends once it's the chat's.
  const title = useUserDraft(EMPTY_CHAT_TITLE, "Title", "")
  const call = useCaller()
  const [opened, setOpened] = useState<Chat | null>(null)
  // The name given, once read: a fresh chat opened after a sweep gets it too.
  const named = useRef<string | null>(null)
  useEffect(() => {
    if (opened === null || !title.ready) return
    const first = named.current === null
    if (first) named.current = title.text.trim()
    const name = named.current!
    if (name === "") return
    void call((client) => client("RenameChat", { chatId: opened.id, name })).then((result) => {
      if (result.ok && first) void title.commit(title.text, async () => true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per chat opened, when the title is read
  }, [opened, title.ready])
  return <DraftChatPage draftFor="empty" onOpened={setOpened} />
}
