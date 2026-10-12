// A chat (DESIGN §10.1): a URL per chat and per message, the path in a virtualized list
// anchored at the bottom, and the composer. Nothing here locks while replies generate.
import { RegistryContext } from "@effect/atom-react"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { Loading } from "../../ui/Spinner.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"
import { chatTitle } from "./ChatsPage.tsx"
import { Composer } from "./Composer.tsx"
import { Message } from "./Message.tsx"
import { perf } from "./perf.ts"
import { ChatSession, type ChatView } from "./session.ts"

/** Load more history when the first or last rendered message is this close to the loaded edge. */
const EDGE = 5
/** Within this many pixels of the end counts as at the end. */
const END_PX = 48

function MessageList({ session, view, anchor }: { session: ChatSession; view: ChatView; anchor: SlotId | null }) {
  // TanStack Virtual's instance is mutable, which React Compiler's memoization can't see.
  "use no memo"
  const parent = useRef<HTMLDivElement>(null)
  const positioned = useRef(0)
  /** Paging waits until a new window is positioned: before that, the list renders from its top. */
  const settled = useRef(false)
  /** Whether the list stays at the end as messages grow or arrive (below). */
  const [follow] = useState({ stuck: true })
  const { entries } = view
  useEffect(() => {
    perf.listRenders++
  })
  // eslint-disable-next-line react-hooks/incompatible-library -- this component opts out of memoization above
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 180,
    getItemKey: (index) => entries[index]!.slotId,
    overscan: 4,
    anchorTo: "end",
    followOnAppend: view.follow,
    paddingStart: 16,
    paddingEnd: 16,
    gap: 12,
    // TanStack Virtual follows a row growing at the very end itself; once the user lets go,
    // it mustn't (below).
    scrollEndThreshold: follow.stuck ? 1 : -1
  })
  /** Holds the list at the end, or lets go of it, for this component and TanStack Virtual alike. */
  const hold = useCallback(
    (on: boolean) => {
      follow.stuck = on
      virtualizer.options.scrollEndThreshold = on ? 1 : -1
    },
    [follow, virtualizer]
  )

  // A new window opens at the asked-for message, or at the bottom.
  useLayoutEffect(() => {
    if (view.opened === positioned.current || entries.length === 0) return
    positioned.current = view.opened
    settled.current = false
    const index = anchor === null ? -1 : entries.findIndex((e) => e.slotId === anchor)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" })
    else virtualizer.scrollToEnd()
    hold(index < 0)
    requestAnimationFrame(() => requestAnimationFrame(() => (settled.current = true)))
  })

  // At the bottom, the list stays there while the last messages grow or arrive, until the
  // user scrolls away. TanStack Virtual follows on its own only while the scroll position
  // is exactly at the end when a row grows, which a send that reopens the window, or a
  // reply growing while that settles, can miss. Widening its threshold instead made it
  // write the scroll position as the user started scrolling up, which stops a smooth
  // scroll in its first few pixels: the list then never let go.
  //
  // The user scrolling up lets go at once, before the first scroll event: a smooth scroll
  // starts with steps small enough to still look like the end. Reaching the end again
  // holds on once the user has stopped for a moment.
  const intent = useRef(0)
  useEffect(() => {
    const list = parent.current
    if (list === null) return
    const atEnd = () => list.scrollHeight - list.scrollTop - list.clientHeight <= END_PX
    const letGo = () => {
      intent.current = performance.now()
      hold(false)
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) letGo()
    }
    const onKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) letGo()
    }
    // Capture runs before the virtualizer's own listener, whose render may follow at once.
    const onScroll = () => {
      if (!atEnd()) hold(false)
    }
    list.addEventListener("wheel", onWheel, { passive: true })
    list.addEventListener("touchmove", letGo, { passive: true })
    list.addEventListener("keydown", onKey)
    list.addEventListener("scroll", onScroll, { passive: true, capture: true })
    return () => {
      list.removeEventListener("wheel", onWheel)
      list.removeEventListener("touchmove", letGo)
      list.removeEventListener("keydown", onKey)
      list.removeEventListener("scroll", onScroll, { capture: true })
    }
  }, [hold])
  useEffect(() => {
    const list = parent.current
    if (list === null || entries.length === 0 || !view.follow) return
    const fromEnd = list.scrollHeight - list.scrollTop - list.clientHeight
    if (!follow.stuck && fromEnd <= END_PX && performance.now() - intent.current > 300) hold(true)
    if (follow.stuck && fromEnd > 1) virtualizer.scrollToEnd()
  })

  const items = virtualizer.getVirtualItems()
  const first = items[0]?.index
  const last = items.at(-1)?.index
  useEffect(() => {
    if (!settled.current || first === undefined || last === undefined) return
    if (first < EDGE) void session.loadOlder()
    if (last >= entries.length - EDGE) void session.loadNewer()
    if (view.newer === null && virtualizer.isAtEnd(END_PX)) session.followAtBottom()
  })

  return (
    <div
      ref={parent}
      data-testid="messages"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]"
    >
      <div className="relative mx-auto w-full max-w-3xl" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const entry = entries[item.index]!
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="chat-row absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <Message
                entry={entry}
                session={session}
                highlighted={entry.slotId === anchor}
                branchLeaf={view.leafSlotId === view.chat?.activeLeafSlotId ? null : view.leafSlotId}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function OpenChat({ chatId, leaf, slot }: { chatId: ChatId; leaf: SlotId | null; slot: SlotId | null }) {
  const registry = useContext(RegistryContext)
  const [session] = useState(() => new ChatSession(chatId, leaf, registry))
  // The slot the chat opened at; a deep link within the open chat moves the window instead.
  const [initialSlot] = useState(slot)
  useEffect(() => {
    session.start(initialSlot)
    return () => session.dispose()
  }, [session, initialSlot])
  return <ChatSurface session={session} leaf={leaf} slot={slot} />
}

function ChatSurface({ session, leaf, slot }: { session: ChatSession; leaf: SlotId | null; slot: SlotId | null }) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const navigate = useNavigate()
  useTitle(view.chat ? chatTitle(view.chat) : "Chat")
  const shown = useRef({ leaf, slot })
  // Another message or branch of the open chat moves the window; a URL catching up with
  // where the window already is doesn't.
  useEffect(() => {
    const before = shown.current
    shown.current = { leaf, slot }
    if (leaf !== before.leaf) {
      const current = view.leafSlotId
      const already = leaf === null ? current !== null && current === view.chat?.activeLeafSlotId : leaf === current
      if (!already) session.showBranch(leaf, slot)
    } else if (slot !== before.slot) void session.open(slot)
  }, [session, leaf, slot, view.leafSlotId, view.chat])
  // Sending on another branch makes it the chat's latest: once the window moves on from the
  // URL's leaf to the active one, the URL drops the old leaf.
  const viewLeaf = useRef(view.leafSlotId)
  useEffect(() => {
    const from = viewLeaf.current
    viewLeaf.current = view.leafSlotId
    if (leaf !== null && from === leaf && view.leafSlotId !== leaf && view.leafSlotId === view.chat?.activeLeafSlotId) {
      void navigate({ to: ".", search: slot === null ? {} : { slot }, replace: true })
    }
  }, [navigate, leaf, slot, view.leafSlotId, view.chat])
  return (
    <>
      <header className="mx-auto flex w-full max-w-3xl items-center gap-3 pb-2">
        <Link to="/chats" className="text-sm text-muted hover:text-text">
          ← Chats
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{view.chat ? chatTitle(view.chat) : "Chat"}</h1>
        {view.leafSlotId !== null && view.chat !== null && view.leafSlotId !== view.chat.activeLeafSlotId && (
          <Link to="." search={{}} className="text-sm text-accent hover:underline">
            Back to the latest branch
          </Link>
        )}
      </header>
      {view.error && (
        <div className="mx-auto w-full max-w-3xl">
          <Alert tone="danger">{view.error}</Alert>
        </div>
      )}
      {view.loading ? (
        <Loading label="Loading the chat…" />
      ) : (
        <MessageList session={session} view={view} anchor={slot} />
      )}
      <Composer session={session} view={view} />
    </>
  )
}

/** /chats/$chatId, with `leaf` for a branch other than the active one and `slot` for a message. */
export function ChatPage() {
  const { chatId } = useParams({ strict: false }) as { chatId: ChatId }
  const search = useSearch({ strict: false }) as { leaf?: unknown; slot?: unknown }
  const leaf = typeof search.leaf === "string" && search.leaf !== "" ? (search.leaf as SlotId) : null
  const slot = typeof search.slot === "string" ? (search.slot as SlotId) : null
  return (
    <div data-fill className="flex min-h-0 flex-1 flex-col">
      <OpenChat key={chatId} chatId={chatId} leaf={leaf} slot={slot} />
    </div>
  )
}
