// A chat (DESIGN §10.1): a URL per chat and per message, the path in a virtualized list
// anchored at the bottom, and the composer. Nothing here locks while replies generate.
import { RegistryContext } from "@effect/atom-react"
import type { ChatId, PathEntry, SlotId } from "@rp/shared/chat.ts"
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react"
import { Button } from "../../ui/Button.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { useLookingAt } from "../notices.tsx"
import { useTitle } from "../shell.tsx"
import { ChatBadges, chatTitle } from "./ChatsPage.tsx"
import { CacheIndicator } from "./CacheIndicator.tsx"
import { CastContext, castView } from "./cast.ts"
import { CastDialog, SettingsDialog } from "./ChatPanels.tsx"
import { EnableLcmDialog } from "./EnableLcmDialog.tsx"
import { Composer } from "./Composer.tsx"
import { CoverageRail, LANE_PX, useCoverage } from "./CoverageRail.tsx"
import { LcmBoundary } from "./LcmBoundary.tsx"
import { setRail, useRail } from "./lcm.ts"
import { Message } from "./Message.tsx"
import { useRenderCount } from "./perf.ts"
import { ChatSession, type ChatView } from "./session.ts"
import { SummaryPanel } from "./SummaryPanel.tsx"

// Loaded when first opened: it carries the note editor.
const NotesDialog = lazy(() => import("./ChatNotes.tsx").then((module) => ({ default: module.NotesDialog })))

/** Load more history when the first or last rendered message is this close to the loaded edge. */
const EDGE = 5
/** Within this many pixels of the end counts as at the end. */
const END_PX = 48

/**
 * Where the divider between summarized and verbatim history goes: the index among `entries`
 * it goes before (entries.length: after the last), or null when the loaded window doesn't
 * hold the boundary.
 */
export function boundaryIndex(view: ChatView): number | null {
  const lcm = view.lcm
  if (lcm === null || !lcm.enabled || lcm.leafSlotId !== view.leafSlotId) return null
  const { entries } = view
  if (entries.length === 0) return null
  let at = entries.findIndex((e) => e.depth > lcm.cursorDepth)
  if (at < 0) at = entries.length
  // Before the loaded window, or after it with more below: not here.
  if (at === 0 && view.older !== null) return null
  if (at === entries.length && view.newer !== null) return null
  return at
}

function MessageList({
  session,
  view,
  anchor,
  rail,
  onBranch,
  onOpenSummaries
}: {
  session: ChatSession
  view: ChatView
  anchor: SlotId | null
  rail: boolean
  onBranch: (entry: PathEntry, index: number) => void
  onOpenSummaries: (focus: string | null) => void
}) {
  // TanStack Virtual's instance is mutable, which React Compiler's memoization can't see.
  "use no memo"
  const parent = useRef<HTMLDivElement>(null)
  const positioned = useRef(0)
  /** Paging waits until a new window is positioned: before that, the list renders from its top. */
  const settled = useRef(false)
  /** Whether the list stays at the end as messages grow or arrive (below). */
  const [follow] = useState({ stuck: true })
  const { entries } = view
  useRenderCount("listRenders")
  const lcm = view.lcm?.enabled === true && view.lcm.leafSlotId === view.leafSlotId ? view.lcm : null
  const history = view.history?.leafSlotId === view.leafSlotId ? view.history : null
  const through = lcm ? (lcm.cursorDepth < 0 ? null : lcm.cursorDepth) : (history?.summarizedThrough ?? null)
  const outOfContext = (entry: PathEntry) =>
    !entry.contextExcluded &&
    history?.historyStart != null &&
    entry.depth < history.historyStart.depth &&
    entry.depth > (through ?? -1)
  const budget = history?.budget
  let historyDivider = -1
  if (budget && entries.length > 0) {
    const start = history.historyStart
    if (start && (entries.some(outOfContext) || (view.older !== null && start.depth > (through ?? -1) + 1))) {
      const at = entries.findIndex((e) => !e.contextExcluded && e.depth >= start.depth && e.depth > (through ?? -1))
      if (at < 0) {
        if (view.newer === null) historyDivider = entries.length
      } else if (at > 0 || entries[at]!.depth === start.depth) historyDivider = at
    } else if (budget.nonHistoryTokens + budget.responseReserve > budget.maximum && view.newer === null) {
      historyDivider = entries.length
    }
  }
  // The divider is a row of its own, before the entry at `divider` (-1: none).
  const divider = boundaryIndex(view) ?? -1
  const rows = Array.from({ length: entries.length + 1 }, (_, index) => [
    ...(index === divider ? [{ kind: "lcm" as const }] : []),
    ...(index === historyDivider ? [{ kind: "history" as const }] : []),
    ...(index < entries.length ? [{ kind: "message" as const, entry: entries[index]! }] : [])
  ]).flat()
  const rowCount = rows.length
  /** The row an entry is shown at. */
  const rowOf = (entry: number) =>
    entry + (divider >= 0 && entry >= divider ? 1 : 0) + (historyDivider >= 0 && entry >= historyDivider ? 1 : 0)
  // eslint-disable-next-line react-hooks/incompatible-library -- this component opts out of memoization above
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parent.current,
    estimateSize: (row) => (rows[row]!.kind === "message" ? 180 : rows[row]!.kind === "lcm" ? 44 : 64),
    getItemKey: (row) => {
      const item = rows[row]!
      return item.kind === "message" ? item.entry.slotId : `${item.kind}-boundary`
    },
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
    if (index >= 0) virtualizer.scrollToIndex(rowOf(index), { align: "center" })
    else virtualizer.scrollToEnd()
    hold(index < 0)
    requestAnimationFrame(() => requestAnimationFrame(() => (settled.current = true)))
  })

  // An end scroll remains pending by row index while the virtualizer measures it.
  // Appending or inserting the summary divider can move the last message to another
  // index. Retarget before the next frame, even if we're still exactly at the end:
  // otherwise reconciliation scrolls to the old row and the scroll listener lets go.
  const lastSlot = entries.at(-1)?.slotId
  useLayoutEffect(() => {
    if (view.follow && follow.stuck && rowCount > 0) virtualizer.scrollToEnd()
  }, [divider, lastSlot, rowCount, view.follow, follow, virtualizer])

  // At the bottom, the list stays there while the last messages grow or arrive, until the
  // user scrolls away. TanStack Virtual follows on its own only while the scroll position
  // is exactly at the end when a row grows, which a send that reopens the window, or a
  // reply growing while that settles, can miss. Widening its threshold instead made it
  // write the scroll position as the user started scrolling up, which stops a smooth
  // scroll in its first few pixels: the list then never let go.
  //
  // The user scrolling up lets go at once, before the first scroll event: a smooth scroll
  // starts with steps small enough to still look like the end. So does grabbing the
  // scrollbar or a middle-button autoscroll. Reaching the end again holds on once the user
  // has stopped for a moment. (A scroll up with none of these, like find in page, lets go
  // only once it's 48 px from the end.)
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
    const onPointerDown = (event: PointerEvent) => {
      const onScrollbar = event.target === list && event.offsetX >= list.clientWidth
      if (onScrollbar || event.button === 1) letGo()
    }
    // Capture runs before the virtualizer's own listener, whose render may follow at once.
    const onScroll = () => {
      if (!atEnd()) hold(false)
    }
    list.addEventListener("wheel", onWheel, { passive: true })
    list.addEventListener("touchmove", letGo, { passive: true })
    list.addEventListener("keydown", onKey)
    list.addEventListener("pointerdown", onPointerDown)
    list.addEventListener("scroll", onScroll, { passive: true, capture: true })
    return () => {
      list.removeEventListener("wheel", onWheel)
      list.removeEventListener("touchmove", letGo)
      list.removeEventListener("keydown", onKey)
      list.removeEventListener("pointerdown", onPointerDown)
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
    if (last >= rowCount - EDGE) void session.loadNewer()
    if (view.newer === null && virtualizer.isAtEnd(END_PX)) session.followAtBottom()
  })

  // What the summaries cover, for the marks on the messages and the rail.
  const railRows = useCoverage(session, entries, lcm, view.lcmVersion, rail && lcm !== null)
  const showRail = rail && lcm !== null
  const railLevels = Math.max(
    1,
    ...(lcm?.layer.map((s) => s.level) ?? []),
    ...railRows.map((s) => s.level),
    ...(lcm?.jobs.map((j) => j.level) ?? [])
  )
  const railPx = showRail ? railLevels * LANE_PX + 6 : 0
  /** Where an entry's row is, from the virtualizer's measurements (estimates for rows not seen yet). */
  const position = (index: number) => {
    const item = virtualizer.measurementsCache[rowOf(index)]
    return item ? { start: item.start, end: item.end } : null
  }

  return (
    <div
      ref={parent}
      data-testid="messages"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]"
    >
      <div className="relative mx-auto w-full max-w-3xl" style={{ height: virtualizer.getTotalSize() }}>
        {showRail && (
          <CoverageRail entries={entries} rows={railRows} lcm={lcm} position={position} onOpen={onOpenSummaries} />
        )}
        {items.map((item) => {
          const row = rows[item.index]!
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="chat-row absolute top-0 left-0 w-full"
              style={{
                transform: `translateY(${item.start}px)`,
                ...(railPx > 0 ? { left: railPx, width: `calc(100% - ${railPx}px)` } : {})
              }}
            >
              {row.kind === "lcm" ? (
                <LcmBoundary lcm={lcm!} onOpen={() => onOpenSummaries(null)} />
              ) : row.kind === "history" ? (
                <Alert>
                  Not sent: the preset “{budget!.presetName}”{budget!.builtinPreset ? " (ST’s built-in default)" : ""}{" "}
                  allows {budget!.maximum.toLocaleString()} tokens, targets {budget!.target.toLocaleString()}, reserves{" "}
                  {budget!.responseReserve.toLocaleString()} for the reply, and the card, prompts and other fixed
                  content take ~{budget!.nonHistoryTokens.toLocaleString()}.
                </Alert>
              ) : (
                <Message
                  summarized={!row.entry.contextExcluded && through !== null && row.entry.depth <= through}
                  outOfContext={outOfContext(row.entry)}
                  entry={row.entry}
                  session={session}
                  highlighted={row.entry.slotId === anchor}
                  branchLeaf={view.leafSlotId === view.chat?.activeLeafSlotId ? null : view.leafSlotId}
                  onBranch={onBranch}
                />
              )}
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
  useLookingAt(chatId)
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
    const current = view.leafSlotId
    const already = leaf === null ? current !== null && current === view.chat?.activeLeafSlotId : leaf === current
    if (leaf !== before.leaf && !already) session.showBranch(leaf, slot)
    else if (slot !== before.slot) void session.open(slot)
  }, [session, leaf, slot, view.leafSlotId, view.chat])
  // Sending on another branch makes it the chat's latest: once the window moves on from the
  // URL's leaf to the active one, the URL drops the old leaf.
  // Deleted while open, here or elsewhere: there's nothing left to show.
  useEffect(() => {
    if (view.deleted) void navigate({ to: "/chats", replace: true })
  }, [navigate, view.deleted])
  const viewLeaf = useRef(view.leafSlotId)
  useEffect(() => {
    const from = viewLeaf.current
    viewLeaf.current = view.leafSlotId
    if (leaf !== null && from === leaf && view.leafSlotId !== leaf && view.leafSlotId === view.chat?.activeLeafSlotId) {
      void navigate({ to: ".", search: slot === null ? {} : { slot }, replace: true })
    }
  }, [navigate, leaf, slot, view.leafSlotId, view.chat])
  // Rows read the cast from context: it's the same object until the cast changes.
  const cast = useMemo(() => castView(view.cast), [view.cast])
  const [panel, setPanel] = useState<"cast" | "settings" | "notes" | "summaries" | "enable" | null>(null)
  /** The summary the panel opens at: one clicked on the rail, or none. */
  const [focus, setFocus] = useState<string | null>(null)
  const rail = useRail()
  const openSummaries = useCallback((summaryId: string | null) => {
    setFocus(summaryId)
    setPanel("summaries")
  }, [])
  const lcmOn = view.lcm?.enabled === true && view.lcm.leafSlotId === view.leafSlotId
  // Another branch (DESIGN §3.2): the chat's leaf moves to it, and the window opens at the
  // message switched to, which the URL then names.
  const [branchError, setBranchError] = useState<string | null>(null)
  const onBranch = useCallback(
    async (entry: PathEntry, index: number) => {
      const result = await session.switchBranch(entry, index)
      if (!result.ok) return setBranchError(result.error.message)
      setBranchError(null)
      const sibling = result.value.slotId
      if (sibling === slot && leaf === null) void session.open(sibling)
      else void navigate({ to: ".", search: { slot: sibling } })
    },
    [session, navigate, slot, leaf]
  )
  const switchBranch = useCallback((entry: PathEntry, index: number) => void onBranch(entry, index), [onBranch])
  // A summary's range opens the window at its first message, as a link to that message does.
  const branchLeaf = view.leafSlotId === view.chat?.activeLeafSlotId ? null : view.leafSlotId
  const jump = useCallback(
    (target: SlotId) => {
      setPanel(null)
      if (target === slot) void session.open(target)
      else
        void navigate({ to: ".", search: branchLeaf === null ? { slot: target } : { leaf: branchLeaf, slot: target } })
    },
    [session, navigate, slot, branchLeaf]
  )
  return (
    <CastContext value={cast}>
      <header className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-1 pb-2">
        <Link to="/chats" className="text-sm text-muted hover:text-text">
          ← Chats
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{view.chat ? chatTitle(view.chat) : "Chat"}</h1>
        {view.chat && <ChatBadges chat={view.chat} />}
        {view.leafSlotId !== null && view.chat !== null && view.leafSlotId !== view.chat.activeLeafSlotId && (
          <Link to="." search={{}} className="text-sm text-accent hover:underline">
            Back to the latest branch
          </Link>
        )}
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" onClick={() => setPanel("cast")}>
            Cast
          </Button>
          <Button variant="ghost" onClick={() => setPanel("notes")}>
            Notes
          </Button>
          {lcmOn && (
            <>
              <Button variant="ghost" onClick={() => openSummaries(null)}>
                Summaries
              </Button>
              <Button variant="ghost" aria-pressed={rail} onClick={() => setRail(!rail)}>
                Coverage rail
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={() => setPanel("settings")}>
            Settings
          </Button>
        </div>
      </header>
      {/* Mounted only while open: the surface re-renders with every page of history. */}
      {panel === "cast" && (
        <CastDialog session={session} open onOpenChange={(open) => setPanel(open ? "cast" : null)} />
      )}
      {panel === "settings" && (
        <SettingsDialog session={session} open onOpenChange={(open) => setPanel(open ? "settings" : null)} />
      )}
      {panel === "summaries" && view.lcm !== null && (
        <SummaryPanel
          session={session}
          lcm={view.lcm}
          focus={focus}
          onJump={jump}
          onOpenChange={(open) => setPanel(open ? "summaries" : null)}
        />
      )}
      {panel === "enable" && (
        <EnableLcmDialog session={session} onOpenChange={(open) => setPanel(open ? "enable" : null)} />
      )}
      {panel === "notes" && (
        <Suspense>
          <NotesDialog
            session={session}
            leafSlotId={view.leafSlotId}
            onOpenChange={(open) => setPanel(open ? "notes" : null)}
          />
        </Suspense>
      )}
      {/* A chat that has outgrown its context with summaries off (spec/LCM.md §2.13): easy to turn on. */}
      {view.lcm !== null &&
        !view.lcm.enabled &&
        view.lcm.leafSlotId === view.leafSlotId &&
        (view.history?.historyStart?.depth ?? 0) > 0 && (
          <div className="mx-auto w-full max-w-3xl pb-2">
            <Alert
              title="Older messages beyond the context aren't summarized"
              actions={
                <Button variant="primary" onClick={() => setPanel("enable")}>
                  Enable summaries
                </Button>
              }
            >
              The model no longer sees them. Summaries keep what happened in them in the context.
            </Alert>
          </div>
        )}
      {(view.error ?? branchError) && (
        <div className="mx-auto w-full max-w-3xl">
          <Alert tone="danger">{view.error ?? branchError}</Alert>
        </div>
      )}
      {view.loading ? (
        <Loading label="Loading the chat…" />
      ) : (
        <MessageList
          session={session}
          view={view}
          anchor={slot}
          rail={rail}
          onBranch={switchBranch}
          onOpenSummaries={openSummaries}
        />
      )}
      <CacheIndicator warmth={view.cache} />
      <Composer session={session} view={view} />
    </CastContext>
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
