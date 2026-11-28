import { ChatBackdrop } from "./ChatBackdrop.tsx"
import { useCoverageRail, useSummariesInChat } from "./chatViewParams.ts"
import { usePlaceParam, usePlaceNotice } from "../../usePlaceParam.ts"
import { useSummariesOfUrl } from "./SummaryViewer.tsx"
import { useTransformedRows, useTimelineInputs, useTimelineTransforms } from "./timelineContributions.tsx"
import { lcmCursor, positionOf } from "./position.ts"
import { SlotOutlet } from "../../slots.tsx"
import {
  ChatSurfaceProviders,
  chatColumns,
  chatOverlays,
  chatComposer,
  chatComposerNotes,
  timelineRails,
  timelineBoundaries,
  timelineSummaries,
  messageStream
} from "./presentation.tsx"
import { useChatCommandKeys } from "./commands.tsx"
import { useIsPanelTab } from "./panels.tsx"
import { FinishMeantTitle, meantTitle } from "./meantTitle.tsx"
// A chat (DESIGN §10.1): a URL per chat and per message, the path in a virtualized list
// anchored at the bottom, and the composer. Nothing here locks while replies generate.
import { RegistryContext } from "@effect/atom-react"
import type { ChatId, ForkId, PathEntry, SlotId } from "@dreamspan/shared/chat.ts"
import { type RouterHistory, useLocation, useNavigate, useParams, useRouter, useSearch } from "@tanstack/react-router"
import { elementScroll, observeElementOffset, useVirtualizer, type Virtualizer } from "@tanstack/react-virtual"
import {
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore
} from "react"
import { flushSync } from "react-dom"
import { Button } from "../../ui/Button.tsx"
import { ChatSkeleton, SkeletonMessages } from "./SkeletonMessages.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { TooltipProvider } from "../../ui/Tooltip.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { useLookingAt } from "../notices.tsx"
import { useSidePanelPlace, useTabFocused, useTabMeta, useWorkbenchTab } from "../workbench/tab.tsx"
import { tabPortrait } from "./tabPortrait.tsx"
import { useChatPicture } from "./splitChats.ts"
import { useSession } from "../../session.ts"
import { CastContext, castView } from "./cast.ts"
import { ChatSidePanel, type PanelTab, rememberPanel, usePanel } from "./ChatPanels.tsx"
import { ChatHeader } from "./ChatHeader.tsx"
import {
  adjustForReading,
  densityMetrics,
  readingAnchor,
  type ReadingAnchor,
  readingDrift,
  readingInset
} from "./readingPlace.ts"
import { ChatDensityContext } from "./ChatDensity.tsx"
import { castCharacters, chatDisplayName } from "./chatTitle.ts"
import { EnableLcmDialog } from "./EnableLcmDialog.tsx"
import { LANE_PX, useCoverage } from "./CoverageRail.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { ANCHORED_SCROLL, AnchoredScrollEvent } from "../../ui/anchorScroll.ts"
import type { CSSProperties } from "react"
import { type ContextMark, Message } from "./Message.tsx"
import { useRenderCount } from "./perf.ts"
import { ChatSession, type ChatView } from "./session.ts"
import { boundaryIndex, placeOf } from "./summaryBoundary.ts"
import { historyLines } from "./historyLines.ts"
import { atNativeEnd, NATIVE_END_PX, trackScrollInput } from "./followScroll.ts"
import { flashWhenShown } from "./jumpFlash.ts"
import { kindRootProps, summarizes, useChatKindLook } from "./kindLooks.ts"
import { composerChoice } from "./speaker.ts"

interface ReadingPosition {
  key: string
  slot: SlotId | null
  offset: number
}
const readingAt = (reading: ReadingPosition | undefined, userId: string, chatId: ChatId, fork: ForkId | null) =>
  fork !== null &&
  reading?.key === `${userId}/${chatId}/${fork}` &&
  (reading.slot === null || (typeof reading.slot === "string" && reading.slot.length > 0)) &&
  Number.isFinite(reading.offset)
    ? reading
    : null

declare module "@tanstack/react-router" {
  interface HistoryState {
    chatReading?: ReadingPosition | undefined
  }
}

/** What MessageList flashed last, kept across its remounts (a timeline layout switch). */
export interface Flashes {
  opened: number
  repeat: { index: number; fork: ForkId | null; slot: SlotId } | null
}

/** Load more history when the first or last rendered message is this close to the loaded edge. */
const EDGE = 5
const SUMMARIZED: ContextMark = {
  kind: "summarized",
  reason: "Summarized: a summary stands in for this message in the context."
}

/**
 * The messages, virtualized. `embedded`: a chat shown inside another's panel (the workshop beside
 * a story), which keeps no reading position in the page's history: that's the page's chat's.
 */
export function MessageList({
  session,
  view,
  anchor,
  jump,
  flashes,
  rail,
  onBranch,
  onOpenSummaries,
  restore,
  beforeComposerSubmit,
  embedded = false
}: {
  session: ChatSession
  view: ChatView
  embedded?: boolean
  anchor: SlotId | null
  /** The message jumped to, which flashes when the window opens at it (jumpFlash.ts); null: none. */
  jump: SlotId | null
  /** The window last flashed (`view.opened`), and whether one opened at the same message flashes again. */
  flashes: RefObject<Flashes>
  restore: ReadingPosition | null
  rail: boolean
  onBranch: (entry: PathEntry, index: number) => void
  onOpenSummaries: (focus: string | null) => void
  beforeComposerSubmit?: RefObject<(() => void) | null>
}) {
  // TanStack Virtual's instance is mutable, which React Compiler's memoization can't see.
  "use no memo"
  const parent = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const userId = useSession().user.id
  const positioned = useRef(0)
  /** Paging waits until a new window is positioned: before that, the list renders from its top. */
  const settled = useRef(false)
  const saveReading = useRef<(() => void) | null>(null)
  const flushInput = useRef<(() => void) | null>(null)
  const stopLinkReveal = useRef<(() => void) | null>(null)
  const tab = useWorkbenchTab()
  const { entries } = view
  const { prefs } = useViewPrefs()
  // The spacing shown follows the account's choice one commit later, once what's being read
  // is noted (below), so the rows, their gap and their estimated heights change together.
  const [spacing, setSpacing] = useState(prefs.chatDensity)
  const metrics = densityMetrics(spacing)
  const summarySlots = useSyncExternalStore(
    timelineSummaries.subscribe,
    timelineSummaries.snapshot,
    timelineSummaries.snapshot
  )
  const boundarySlots = useSyncExternalStore(
    timelineBoundaries.subscribe,
    timelineBoundaries.snapshot,
    timelineBoundaries.snapshot
  )
  const railSlots = useSyncExternalStore(timelineRails.subscribe, timelineRails.snapshot, timelineRails.snapshot)
  const [summariesInChat] = useSummariesInChat(view.lcm?.enabled === true)
  const summaries = summariesInChat && summarySlots.entries.length > 0
  useRenderCount("listRenders")
  const lcm = view.lcm?.enabled === true && view.lcm.leafSlotId === view.leafSlotId ? view.lcm : null
  const history = view.history?.leafSlotId === view.leafSlotId ? view.history : null
  // The summary cursor and the history start are positions on the fork's display path.
  const cursor = lcm === null ? null : (lcm.cursorPosition ?? lcm.cursorDepth)
  const through = cursor === null ? (history?.summarizedThrough ?? null) : cursor < 0 ? null : cursor
  const outOfContext = (entry: PathEntry) =>
    !entry.contextExcluded &&
    history?.historyStart != null &&
    placeOf(entry) < history.historyStart.depth &&
    placeOf(entry) > (through ?? -1)
  const budget = history?.budget
  /** Why a message left the context, said the same way on each (DESIGN §5.5). */
  const droppedReason = history?.historyStart
    ? `Not sent to the model: the history sent starts at #${history.historyStart.depth + 1}${
        budget
          ? `, to fit the model’s context budget (at most ${budget.maximum.toLocaleString()} tokens; when it's full, older messages leave until it's down to ${budget.target.toLocaleString()})`
          : ""
      }.${lcm === null && through === null ? " Summaries are off, so nothing stands in for it." : ""}`
    : "Not sent to the model: it's before where the history sent starts."
  // The same object while the reason holds, so rows that didn't change don't render again.
  const droppedMark = useMemo<ContextMark>(() => ({ kind: "dropped", reason: droppedReason }), [droppedReason])
  const contextOf = (entry: PathEntry): ContextMark | null =>
    entry.contextExcluded
      ? null
      : through !== null && placeOf(entry) <= through
        ? SUMMARIZED
        : outOfContext(entry)
          ? droppedMark
          : null
  /** The message whose actions show after a tap, on a narrow screen. */
  const [revealed, setRevealed] = useState<SlotId | null>(null)
  useEffect(() => {
    if (spacing !== "compact" || revealed === null) return
    const dismiss = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return
      const message = event.target.closest("article[data-slot]")
      // Portalled menus and pickers still belong to the revealed message.
      if (message?.getAttribute("data-slot") === revealed || event.target.closest("[data-layout-overlay]")) return
      setRevealed(null)
    }
    // Dismiss after the tapped control handles its click. Shrinking the previous row on
    // pointerdown could move that control away before pointerup and swallow the action.
    document.addEventListener("click", dismiss)
    return () => document.removeEventListener("click", dismiss)
  }, [spacing, revealed])
  // The size line under the last message the budget left out, and the hidden line above the
  // first message sent after a hidden run (historyLines.ts).
  const { size: historyDivider, hidden: hiddenDivider } = historyLines(view, through)
  // The divider is a row of its own, before the entry at `divider` (-1: none).
  const divider =
    boundarySlots.entries.length === 0
      ? -1
      : summaries && lcm && lcm.layer.length > 0 && (entries[0] ? positionOf(entries[0]) : -1) > lcmCursor(lcm)
        ? 0
        : (boundaryIndex(view) ?? -1)
  const transforms = useTimelineTransforms()
  // A transform's own inputs (the threads' sets) changed: the rows are made again.
  const inputs = useTimelineInputs()
  const timelineContext = useMemo(
    () => ({ view, lcm, summaries, divider, historyDivider, hiddenDivider }),
    [view, lcm, summaries, divider, historyDivider, hiddenDivider]
  )
  const rows = useTransformedRows(entries, transforms.entries, timelineContext, inputs)
  const rowCount = rows.length
  /** The row an entry is shown at. */
  const rowOf = (entry: number) =>
    rows.findIndex((row) => positionOf(entries[entry]!) >= row.from && positionOf(entries[entry]!) <= row.to)
  const requested =
    restore !== null ? restore.slot : (anchor ?? (summaries ? (lcm?.layer.at(-1)?.lastSlotId ?? null) : null))
  const requestedEntry = requested === null ? -1 : entries.findIndex((entry) => entry.slotId === requested)
  const requestedRow =
    requested === null
      ? -1
      : requestedEntry >= 0
        ? rowOf(requestedEntry)
        : rows.findIndex((row) => row.key === requested || row.lastSlotId === requested)
  // A newly opened window starts at its destination. Only input completion updates that window's choice.
  const newFollow = () => ({
    opened: view.opened,
    on: requestedRow < 0 && view.newer === null,
    moving: false,
    anchors: 0,
    get pinned(): boolean {
      return this.on && !this.moving && this.anchors === 0
    }
  })
  const [follow, setFollow] = useState(newFollow)
  if (follow.opened !== view.opened) setFollow(newFollow())
  const estimateSize = useCallback(
    (row: number) => Math.round(rows[row]!.estimate * metrics.estimate),
    [rows, metrics.estimate]
  )
  const getItemKey = useCallback((row: number) => rows[row]!.key, [rows])
  const offsetChanged = useRef<((offset: number, isScrolling: boolean) => void) | null>(null)
  const observeOffset = useCallback(
    (instance: Virtualizer<HTMLDivElement, Element>, changed: (offset: number, isScrolling: boolean) => void) => {
      offsetChanged.current = changed
      const stop = observeElementOffset(instance, changed)
      return () => {
        offsetChanged.current = null
        stop?.()
      }
    },
    []
  )
  // While the list scrolls, TanStack Virtual measures newly mounted rows only in its resize
  // observer, before the browser paints, but re-renders for a size that moves nothing above the
  // screen in a later task: for one painted frame the rows on screen stood at their estimated
  // places, a strip of empty list between messages where a row came out shorter than its
  // estimate (masterfix1: readingDensity.perf.ts' blank frames, 32 px in Comfortable). Apply
  // such a measurement before the paint: a microtask after the observer's callback is still
  // before it, and outside React's own render and commit, so flushSync is allowed there.
  // Not while the list is held at the end: there the virtualizer's own end-follow writes the
  // scroll position and renders synchronously, and an extra render in between let a reply's
  // burst land unfollowed (masterfix1: chat.perf.ts' bursty stream, 465-570 px from the end).
  const [, repaint] = useReducer((n: number) => n + 1, 0)
  const repaintQueued = useRef(false)
  const onVirtualChange = useCallback(
    (_instance: Virtualizer<HTMLDivElement, Element>, sync: boolean) => {
      if (sync || follow.pinned || repaintQueued.current) return
      repaintQueued.current = true
      queueMicrotask(() => {
        repaintQueued.current = false
        flushSync(repaint)
      })
    },
    [follow]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- this component opts out of memoization above
  const virtualizer = useVirtualizer({
    onChange: onVirtualChange,
    count: rowCount,
    getScrollElement: () => parent.current,
    estimateSize,
    getItemKey,
    observeElementOffset: observeOffset,
    // Start near the destination. Mounting the first window's first rows only to replace
    // them with its last rows in the layout effect also mounted their controls and reads.
    initialOffset: () => {
      let offset = 16
      for (let i = 0; i < (requestedRow < 0 ? rows.length : requestedRow); i++) offset += estimateSize(i) + metrics.gap
      return offset
    },
    overscan: 2,
    anchorTo: "end",
    followOnAppend: follow.pinned,
    paddingStart: 16,
    paddingEnd: 16,
    gap: metrics.gap,
    // TanStack Virtual follows a row growing at the very end itself; once the user lets go,
    // it mustn't (below).
    scrollEndThreshold: follow.pinned ? NATIVE_END_PX : -1
  })
  const syncPinning = useCallback(() => {
    virtualizer.options.followOnAppend = follow.pinned
    virtualizer.options.scrollEndThreshold = follow.pinned ? NATIVE_END_PX : -1
    // TanStack Virtual has no cancellation API for an end scroll already reconciling by row index.
    if (!follow.pinned && virtualizer["scrollState"]?.align === "end") virtualizer["scrollState"] = null
  }, [follow, virtualizer])
  const keepEnd = useCallback(() => {
    const list = parent.current
    if (list !== null && follow.pinned && !atNativeEnd(list)) virtualizer.scrollToEnd()
  }, [follow, virtualizer])
  const finishScrollInput = useCallback(
    (atEnd: boolean, save: boolean) => {
      follow.on = atEnd && session.snapshot().newer === null
      follow.moving = false
      syncPinning()
      keepEnd()
      // A stationary release can change follow without emitting another scroll event.
      if (save) saveReading.current?.()
    },
    [follow, keepEnd, session, syncPinning]
  )
  useLayoutEffect(() => {
    if (!beforeComposerSubmit) return
    beforeComposerSubmit.current = () => {
      const list = parent.current
      const current = session.snapshot()
      // The destination is positioned in the layout effect. The deferred offset correction
      // can still be queued when the user submits from the end of a short branch.
      if (list === null || positioned.current !== current.opened || current.newer !== null || !atNativeEnd(list)) return
      stopLinkReveal.current?.()
      flushInput.current?.()
      finishScrollInput(true, true)
    }
    return () => {
      beforeComposerSubmit.current = null
    }
  }, [beforeComposerSubmit, finishScrollInput, session])

  // The virtualizer learns the list's offset through its scroll observer. When the browser clamps
  // an offset it set to where the list already is (the estimated start in a history too short
  // to scroll, a destination at the top, a row kept in place as rows above it change), none
  // fires, and the rows between the real offset and its own would never mount.
  // Report a correction, not active scrolling: React flushes a layout-effect update before
  // paint itself; a scroll event would make the adapter call flushSync during that commit.
  const syncOffset = useCallback(() => {
    const list = parent.current
    if (list === null) return
    const actual = list.scrollTop
    const expected = virtualizer.scrollOffset ?? 0
    if (Math.abs(expected - actual) < 1) return
    offsetChanged.current?.(actual, false)
  }, [virtualizer])
  useLayoutEffect(syncOffset)

  // Contributions can grow below a partly visible earlier row whose text is already
  // above the viewport. Keep the reading row fixed through a resize batch: querying
  // it after each scroll correction can choose a different row before positions commit.
  useLayoutEffect(() => {
    const list = parent.current
    if (list === null) return
    let readingRow: HTMLElement | null = null
    const remember = () => {
      const anchor = readingAnchor(list)
      readingRow = anchor === null ? null : list.querySelector(`.chat-row[data-index="${anchor.row}"]`)
    }
    remember()
    const previous = virtualizer.shouldAdjustScrollPositionOnItemSizeChange
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
      if (readingRow === null || !list.contains(readingRow)) remember()
      return adjustForReading(item, virtualizer, readingRow === null ? null : Number(readingRow.dataset.index))
    }
    // Scroll events follow the virtualizer's committed positions, including after
    // a resize batch; a real scroll picks the new reading row in the same way.
    list.addEventListener("scroll", remember, { passive: true })
    return () => {
      list.removeEventListener("scroll", remember)
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange = previous
    }
  }, [virtualizer])

  // Changing the message spacing resizes every row, and the gaps between them. What's being
  // read keeps its place on screen: the first text in view is noted before anything changes,
  // and the list is put back around it once the rows are laid out again, and again over the
  // next frames as they're measured. At the end of the chat the list stays at the end.
  const reading = useRef<{ key: string; anchor: ReadingAnchor } | "end" | null>(null)
  const correctReading = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    if (prefs.chatDensity === spacing) return
    const list = parent.current
    const anchor = list === null || follow.pinned ? null : readingAnchor(list)
    const row = anchor === null ? undefined : rows[anchor.row]
    reading.current = anchor !== null && row !== undefined ? { key: row.key, anchor } : list === null ? null : "end"
    // Heights measured at the other spacing are wrong for rows that aren't shown: those go back
    // to estimates, so each is measured afresh, and the list corrected for it, when it's reached.
    setSpacing(prefs.chatDensity)
  }, [prefs.chatDensity, spacing, follow, rows, virtualizer])
  useLayoutEffect(() => {
    const list = parent.current
    const kept = reading.current
    reading.current = null
    if (list === null || kept === null) return
    // Use the public reset so both the size cache and its memoized measurements invalidate.
    virtualizer.measure()
    if (kept === "end") {
      virtualizer.scrollToEnd()
      return
    }
    const row = rows.findIndex((candidate) => candidate.key === kept.key)
    if (row < 0) return
    const moveBy = (drift: number) => {
      virtualizer.scrollToOffset(Math.max(0, list.scrollTop + drift))
      syncOffset()
    }
    // The rows shown have their new heights already, but the list still places them by the old
    // ones until its observer reports each. Told now, without its own scroll corrections (this
    // effect makes the one that counts), it has every row's new place before the first paint.
    const previousAdjustment = virtualizer.shouldAdjustScrollPositionOnItemSizeChange
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false
    for (const element of list.querySelectorAll<HTMLElement>(".chat-row[data-index]"))
      virtualizer.resizeItem(Number(element.dataset.index), element.getBoundingClientRect().height)
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = previousAdjustment
    virtualizer.getVirtualItems()
    const item = virtualizer.measurementsCache[row]
    if (item === undefined) return
    // Where the text read sits inside its row doesn't depend on where the row is placed.
    virtualizer.scrollToOffset(Math.max(0, item.start + readingInset(list, kept.anchor, row)))
    syncOffset()
    let frame = 0
    let steady = 0
    const started = performance.now()
    const inputs = ["wheel", "touchmove", "keydown", "pointerdown"] as const
    const stop = () => {
      correctReading.current = null
      cancelAnimationFrame(frame)
      for (const event of inputs) list.removeEventListener(event, stop)
    }
    const settle = () => {
      const drift = readingDrift(list, kept.anchor, row)
      if (drift !== null && Math.abs(drift) >= 1) {
        steady = 0
        moveBy(drift)
      } else steady++
      if (steady < 4 && performance.now() - started < 1000) frame = requestAnimationFrame(settle)
      else stop()
    }
    // This commit still has the previous virtual positions in its DOM. resizeItem
    // queued the measured positions for the next commit; correcting now would add
    // that stale layout's drift to the new offset and can unmount the anchor.
    let handoverCommit = true
    correctReading.current = () => {
      if (handoverCommit) {
        handoverCommit = false
        return
      }
      const drift = readingDrift(list, kept.anchor, row)
      if (drift !== null && Math.abs(drift) >= 0.5) moveBy(drift)
    }
    for (const event of inputs) list.addEventListener(event, stop, { passive: true })
    frame = requestAnimationFrame(settle)
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per spacing change, with the rows of that render
  }, [spacing])
  // resizeItem schedules a commit with new row positions. Correct after that commit, before
  // paint; waiting only for rAF allows its old DOM positions to show for one frame.
  useLayoutEffect(() => correctReading.current?.())

  // A new window opens at the asked-for message, or at the bottom.
  // With summaries in the chat, a link waits for the layer: placed among the originals first,
  // the list would keep that offset when the layer replaces them, far from the summary that
  // holds the message, which then never renders, so never expands to it.
  // A layer that can't be read doesn't hold the link for long.
  const layerPending =
    summaries && anchor !== null && (view.lcm === null || (view.lcm.enabled && view.lcm.leafSlotId !== view.leafSlotId))
  const [waitedFor, setWaitedFor] = useState(0)
  useEffect(() => {
    if (!layerPending) return
    const timer = setTimeout(() => setWaitedFor(view.opened), 3000)
    return () => clearTimeout(timer)
  }, [layerPending, view.opened])
  useLayoutEffect(() => {
    if (view.opened === positioned.current) return
    if (layerPending && waitedFor !== view.opened) return
    positioned.current = view.opened
    settled.current = false
    if (requestedRow >= 0)
      virtualizer.scrollToIndex(requestedRow, {
        align: rows[requestedRow]?.lastSlotId !== undefined ? "start" : "center"
      })
    else virtualizer.scrollToEnd()
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        settled.current = true
        syncOffset()
      })
    )
  })

  // A jump flashes its message once, then leaves it unmarked (owner, 2026-11-06). Coming back to
  // the history entry (back, forward, a reload, its tab) opens at the message without flashing.
  const router = useRouter()
  // Pages loading while it waits for its message don't cancel it; another jump or leaving does.
  const pendingFlash = useRef<(() => void) | null>(null)
  useEffect(() => () => pendingFlash.current?.(), [])
  useEffect(() => {
    const list = parent.current
    const flashed = flashes.current
    if (list === null || entries.length === 0 || flashed.opened === view.opened) return
    flashed.opened = view.opened
    pendingFlash.current?.()
    pendingFlash.current = null
    if (jump === null) return
    const key = `${session.id}/${jump}`
    const location = router.state.location
    const repeat = flashed.repeat
    flashed.repeat = null
    if (
      location.state.chatFlashed === key &&
      !(
        repeat?.index === location.state.__TSR_index &&
        repeat.fork === (location.search.fork ?? null) &&
        repeat.slot === jump
      )
    )
      return
    pendingFlash.current = flashWhenShown(list, jump, () => {
      if (router.state.location.state.chatFlashed !== key)
        void navigate({
          to: ".",
          search: (prev: Record<string, unknown>) => prev,
          state: (prev) => ({ ...prev, chatFlashed: key }),
          replace: true,
          resetScroll: false
        })
    })
  }, [jump, view.opened, entries.length, flashes, session, router, navigate])
  // A message just inserted flashes where it went (spec/MESSAGE-INSERT.md §4.3).
  useEffect(() => {
    const list = parent.current
    if (list !== null && view.highlight !== null) return flashWhenShown(list, view.highlight)
  }, [view.highlight])

  // Row contributions and summary expansions load asynchronously. Position the linked
  // article each time a new one mounts, after the virtualizer measures its row:
  // the uncovered original can render first, before the selected layer replaces it.
  // Until the user takes over, the list mustn't hold at the end either: a collapsed
  // summary can fit the viewport, and holding there would follow its expansion down.
  useEffect(() => {
    const list = parent.current
    if (anchor === null || list === null) return
    let frame = 0
    let shown: Element | null = null
    // Keep the linked message in place while asynchronous row contributions arrive.
    // The default anchors only rows entirely above the viewport; a marker added below
    // a partly visible earlier message would otherwise push the link down. Stop using
    // this requested-message anchor as soon as the user takes over, like reveal below.
    // It only holds while the linked message is on screen: once the list is somewhere else
    // (a scroll with no input event, the link unmounted) the ordinary reading anchor
    // applies, or rows growing between the screen and the link would move what's read, and
    // older pages landing above it wouldn't be corrected at all (masterfix1).
    const previousAdjustment = virtualizer.shouldAdjustScrollPositionOnItemSizeChange
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) => {
      const row = shown?.closest<HTMLElement>("[data-index]")
      if (row !== undefined && row !== null && list.contains(row)) {
        const box = row.getBoundingClientRect()
        const view = list.getBoundingClientRect()
        if (box.bottom > view.top && box.top < view.bottom) return item.index < Number(row.dataset.index)
      }
      return previousAdjustment
        ? previousAdjustment(item, delta, instance)
        : item.start < (instance.scrollOffset ?? 0) + instance.scrollAdjustments
    }
    const reveal = () => {
      const article = list.querySelector(`article[data-slot="${CSS.escape(anchor)}"]`)
      if (!article || article === shown) return
      shown = article
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          // Replace the pending summary-row scroll with an offset inside that row.
          // Otherwise its measurement pass can scroll back to the summary's edge.
          const inset =
            restore?.slot === anchor ? restore.offset : (list.clientHeight - article.getBoundingClientRect().height) / 2
          const offset = list.scrollTop + article.getBoundingClientRect().top - list.getBoundingClientRect().top - inset
          virtualizer.scrollToOffset(Math.max(0, offset))
        })
      })
    }
    const stop = () => {
      if (stopLinkReveal.current !== stop) return
      stopLinkReveal.current = null
      cancelAnimationFrame(frame)
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange = previousAdjustment
      observer.disconnect()
      for (const event of inputs) list.removeEventListener(event, stop)
    }
    const inputs = ["wheel", "touchmove", "keydown", "pointerdown"] as const
    stopLinkReveal.current = stop
    for (const event of inputs) list.addEventListener(event, stop, { passive: true })
    const observer = new MutationObserver(reveal)
    observer.observe(list, { childList: true, subtree: true })
    reveal()
    return stop
  }, [anchor, restore, summaries, view.opened, virtualizer])

  // An end scroll remains pending by row index while the virtualizer measures it.
  // Appending or inserting the summary divider can move the last message to another
  // index. Retarget before the next frame so reconciliation scrolls to the new last row.
  const lastSlot = entries.at(-1)?.slotId
  useLayoutEffect(() => {
    if (follow.pinned && rowCount > 0) virtualizer.scrollToEnd()
  }, [divider, lastSlot, rowCount, follow, virtualizer])

  useEffect(() => {
    const list = parent.current
    if (list === null) return
    const track = trackScrollInput(list, {
      following: () => follow.on,
      suspend: () => {
        if (follow.moving) return
        follow.moving = true
        syncPinning()
      },
      keepEnd,
      settle: finishScrollInput
    })
    flushInput.current = track.flush
    const anchorScroll = (event: Event) => {
      if (!(event instanceof AnchoredScrollEvent)) return
      follow.anchors++
      syncPinning()
      event.detail(() => {
        follow.anchors--
        if (flushInput.current !== track.flush) return
        syncPinning()
        keepEnd()
      })
    }
    list.addEventListener(ANCHORED_SCROLL, anchorScroll)
    return () => {
      flushInput.current = null
      track.dispose()
      list.removeEventListener(ANCHORED_SCROLL, anchorScroll)
    }
  }, [finishScrollInput, follow, keepEnd, syncPinning])

  // The list held at the end stays there when it gets shorter: the composer below growing with
  // a line of text, or a note above it appearing. The browser keeps the scroll position, which
  // left the last message behind the list's edge until something else rendered the list.
  useEffect(() => {
    const list = parent.current
    if (list === null || typeof ResizeObserver === "undefined") return
    let height = list.clientHeight
    const observer = new ResizeObserver(() => {
      const shorter = list.clientHeight < height
      height = list.clientHeight
      if (!shorter || !follow.pinned) return
      // Before this frame paints (the virtualizer's own scroll lands a frame later), then theirs.
      elementScroll(list.scrollHeight - height, {}, virtualizer)
      virtualizer.scrollToEnd()
    })
    observer.observe(list)
    return () => observer.disconnect()
  }, [follow, virtualizer])
  // Corrections and layout clamps cannot change the reader's follow choice.
  useEffect(() => keepEnd())

  useLayoutEffect(() => {
    const list = parent.current
    if (!list || embedded) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const save = () => {
      if (!settled.current || !view.forkId) return
      const location = router.history.location
      if (location.pathname !== `/chats/${session.id}`) return
      const fork = new URLSearchParams(location.search).get("fork")
      if (fork !== null && fork !== view.forkId) return
      const reading: ReadingPosition = {
        key: `${userId}/${session.id}/${view.forkId}`,
        slot: null,
        offset: 0
      }
      if (!follow.on) {
        const bounds = list.getBoundingClientRect()
        const article = [...list.querySelectorAll<HTMLElement>("article[data-slot]")].find((element) => {
          const box = element.getBoundingClientRect()
          return box.bottom > bounds.top && box.top < bounds.bottom
        })
        if (!article) return
        reading.slot = article.dataset.slot as SlotId
        reading.offset = article.getBoundingClientRect().top - bounds.top
      }
      const previous = location.state.chatReading
      if (previous?.key === reading.key && previous.slot === reading.slot && previous.offset === reading.offset) return
      router.history.replace(location.href, { ...location.state, chatReading: reading }, { ignoreBlocker: true })
    }
    const flush = () => {
      flushInput.current?.()
      save()
    }
    saveReading.current = save
    const scroll = () => {
      clearTimeout(timer)
      timer = setTimeout(save, 200)
    }
    const unregister = tab?.store.saveEntryOnLeave(tab.tabId, flush)
    list.addEventListener("scroll", scroll, { passive: true })
    window.addEventListener("pagehide", flush)
    return () => {
      unregister?.()
      saveReading.current = null
      clearTimeout(timer)
      list.removeEventListener("scroll", scroll)
      window.removeEventListener("pagehide", flush)
    }
  }, [router, session, userId, view.forkId, embedded, follow, tab])

  const items = virtualizer.getVirtualItems()
  const first = items[0]?.index
  const last = items.at(-1)?.index
  useEffect(() => {
    if (!settled.current || first === undefined || last === undefined) return
    if (first < EDGE && (!summaries || lcm === null || (entries[0] ? positionOf(entries[0]) : 0) > lcmCursor(lcm) + 1))
      void session.loadOlder()
    if (last >= rowCount - EDGE) void session.loadNewer()
  })

  // What the summaries cover, for the marks on the messages and the rail.
  const showRail = rail && lcm !== null && railSlots.entries.length > 0
  const railRows = useCoverage(session, entries, lcm, view.lcmVersion, showRail)
  const railLevels = Math.max(
    1,
    ...(lcm?.layer.map((s) => s.level) ?? []),
    ...railRows.map((s) => s.level),
    ...(lcm?.jobs.map((j) => j.level) ?? [])
  )
  const railPx = showRail ? railLevels * LANE_PX + 6 : 0
  /** Where an entry's row is, from the virtualizer's measurements (estimates for rows not seen yet). */
  const position = (index: number) => {
    const row = rowOf(index)
    const item = row < 0 ? undefined : virtualizer.measurementsCache[row]
    return item ? { start: item.start, end: item.end } : null
  }

  const renderMessage = (entry: PathEntry) => (
    <>
      {view.older === null && entries[0]?.slotId === entry.slotId && (
        <SlotOutlet slot={messageStream} props={{ entry, session, place: "above" }} />
      )}
      <Message
        context={contextOf(entry)}
        revealed={revealed === entry.slotId}
        onReveal={setRevealed}
        entry={entry}
        session={session}
        branchFork={view.forkId}
        onBranch={onBranch}
        onScrollIntoView={syncOffset}
      />
      <SlotOutlet slot={messageStream} props={{ entry, session, place: "below" }} />
    </>
  )

  return (
    <ChatDensityContext value={spacing}>
      <TooltipProvider>
        <div
          ref={parent}
          data-testid={embedded ? "side-chat-messages" : "messages"}
          data-chat-density={spacing}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none] [&::-webkit-scrollbar-thumb]:h-4"
        >
          <div className="relative chat-column" style={{ height: virtualizer.getTotalSize() }}>
            {showRail && (
              <SlotOutlet
                slot={timelineRails}
                props={{ entries, rows: railRows, lcm, position, onOpen: onOpenSummaries }}
              />
            )}
            {items.map((item) => {
              const row = rows[item.index]!
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="chat-row absolute left-0 w-full"
                  // Placed by `top`, not a transform: a transformed row would keep a reply's sticky
                  // Stop (Message.tsx) from holding to the bottom of the view.
                  style={{
                    top: item.start,
                    ...(railPx > 0 ? { left: railPx, width: `calc(100% - ${railPx}px)` } : {})
                  }}
                >
                  {row.render({ session, anchor, renderMessage, onOpenSummaries })}
                </div>
              )
            })}
          </div>
        </div>
      </TooltipProvider>
    </ChatDensityContext>
  )
}

/**
 * What a new-chat page (DraftChatPage.tsx) asks of the chat page it shows: told once when its
 * pending chat is started (its first turn committed it), with the view as it stands then.
 */
export interface DraftHost {
  readonly onStarted: (view: ChatView) => void
  /** The server swept the chat while it was open (it had no tab for a while): open another. */
  readonly onDeleted: () => void
  /** Opened with Guidance on (New chat with this cast from a chat that had it on): its composer starts so. */
  readonly guidance?: boolean
}

export function OpenChat({
  chatId,
  fork,
  slot,
  panel,
  draft = null
}: {
  chatId: ChatId
  fork: ForkId | null
  slot: SlotId | null
  panel: PanelTab | null
  draft?: DraftHost | null
}) {
  const registry = useContext(RegistryContext)
  const userId = useSession().user.id
  const reading = useLocation({ select: (l) => l.state.chatReading })
  // Capture the initial destination once per chat. Later links within this chat still
  // move its existing window through ChatSurface rather than starting another session.
  const [target, setTarget] = useState({ chatId, fork, slot, panel, reading })
  const [active, setActive] = useState<{
    key: number
    session: ChatSession
    restore: ReadingPosition | null
  } | null>(null)
  if (target.chatId !== chatId || (active?.session.id !== chatId && (target.fork !== fork || target.slot !== slot)))
    setTarget({ chatId, fork, slot, panel, reading })
  // A seeded session (the first send from a pending chat) is ready synchronously;
  // publish it before paint so that handover keeps its existing no-skeleton behaviour.
  useLayoutEffect(() => {
    const session = new ChatSession(target.chatId, target.fork, registry, userId, (title) => showToast({ title }))
    const restore = readingAt(target.reading, userId, target.chatId, target.fork)
    let accepted = false
    const ready = () => {
      if (accepted || session.snapshot().loading) return
      accepted = true
      setActive((before) => ({ key: (before?.key ?? 0) + 1, session, restore }))
    }
    const unsubscribe = session.subscribe(ready)
    session.start(restore ? restore.slot : target.slot)
    ready()
    return () => {
      unsubscribe()
      if (!accepted) session.dispose()
    }
  }, [target, registry, userId])
  useEffect(() => () => active?.session.dispose(), [active])
  const pending = active?.session.id !== chatId
  const [surface, setSurface] = useState({ chatId, fork, slot, panel })
  if (
    !pending &&
    (surface.chatId !== chatId || surface.fork !== fork || surface.slot !== slot || surface.panel !== panel)
  )
    setSurface({ chatId, fork, slot, panel })
  useLookingAt(active?.session.id ?? chatId)
  if (!active) return <ChatSkeleton onRetry={() => window.location.reload()} />
  // The outgoing surface keeps its own destination until the new read finishes. Inert
  // prevents an edit or a branch action against the outgoing chat during that interval.
  return (
    <div className="flex min-h-0 flex-1 flex-col" inert={pending} aria-busy={pending}>
      <ChatSurface
        key={active.key}
        session={active.session}
        fork={pending ? surface.fork : fork}
        slot={pending ? surface.slot : slot}
        panel={pending ? surface.panel : panel}
        restore={active.restore}
        pending={pending}
        draft={draft}
      />
    </div>
  )
}

function ChatSurface({
  session,
  fork,
  slot,
  panel: urlPanel,
  restore,
  pending,
  draft
}: {
  session: ChatSession
  fork: ForkId | null
  slot: SlotId | null
  panel: PanelTab | null
  restore: ReadingPosition | null
  pending: boolean
  draft: DraftHost | null
}) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const beforeComposerSubmit = useRef<(() => void) | null>(null)
  const onBeforeSubmit = useCallback(() => beforeComposerSubmit.current?.(), [])
  // A new chat's page hands over to the chat's own once its first turn started it.
  const started = view.chat !== null && view.chat.status !== "pending"
  useEffect(() => {
    if (draft !== null && started) draft.onStarted(session.snapshot())
  }, [draft, started, session])
  // A new chat asked for with Guidance on turns it on in its composer, once its choice is read.
  useEffect(() => {
    if (draft?.guidance !== true) return
    const choices = composerChoice(session)
    let done = false
    const apply = () => {
      const state = choices.snapshot()
      if (done || state.draftId === null || !state.loaded) return
      done = true
      if (!state.guidance) void choices.change({ guidance: true })
    }
    const unsubscribe = choices.subscribe(apply)
    apply()
    return unsubscribe
  }, [draft, session])
  const navigate = useNavigate()
  const router = useRouter()
  const { panel, show, close, chatMain, withPanel, wide, userId } = usePanel(urlPanel, view)
  const entry = useLocation({ select: (location) => location.state })
  const shown = useRef({ fork, slot, index: entry.__TSR_index })
  const [reading, setReading] = useState(restore)
  const traversal = useRef<string | undefined>(undefined)
  useEffect(() => {
    const history: RouterHistory = router.history
    return history.subscribe(({ action, location }) => {
      if (action.type !== "REPLACE") traversal.current = action.type === "PUSH" ? undefined : location.state.__TSR_key
    })
  }, [router])
  const flashes = useRef<Flashes>({ opened: 0, repeat: null })
  // An explicit jump replaces a restored reading position, even at the URL's existing slot.
  const reopen = useCallback(
    (target: SlotId) => {
      setReading(null)
      flashes.current.repeat = { index: router.state.location.state.__TSR_index, fork, slot: target }
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => prev,
        // Explicit clears also replace these keys in the workbench's browser-history mirror.
        state: (prev) => ({ ...prev, chatReading: undefined, chatFlashed: undefined }),
        replace: true,
        resetScroll: false
      })
      void session.open(target)
    },
    [fork, navigate, router, session]
  )
  // Another message or fork of the open chat moves the window; a URL catching up with
  // where the window already is doesn't. A fresh link to the same message is a new jump;
  // replacements that save scroll/flash state and consumed Back/Forward entries aren't.
  useEffect(() => {
    if (pending) return
    const before = shown.current
    const changedEntry = entry.__TSR_index !== before.index
    const wasTraversal = traversal.current !== undefined && traversal.current === entry.__TSR_key
    if (wasTraversal) traversal.current = undefined
    shown.current = { fork, slot, index: entry.__TSR_index }
    if (fork !== before.fork || slot !== before.slot || changedEntry) flashes.current.repeat = null
    const current = view.forkId
    const destinationFork = fork ?? view.chat?.currentForkId ?? null
    const already = destinationFork !== null && current === destinationFork
    const destinationReading = readingAt(entry.chatReading, userId, session.id, destinationFork)
    const fresh = slot !== null && changedEntry && !destinationReading && entry.chatFlashed !== `${session.id}/${slot}`
    if (fork !== before.fork && !already) {
      setReading(destinationReading)
      session.showFork(fork, destinationReading ? destinationReading.slot : slot)
    } else if (slot !== before.slot || fresh || (wasTraversal && destinationReading)) {
      setReading(destinationReading)
      void session.open(destinationReading ? destinationReading.slot : slot)
    }
  }, [session, fork, slot, view.forkId, view.chat, entry, pending, userId])
  // Deleted while open, here or elsewhere: there's nothing left to show. A new chat's page
  // opens another for the same entry instead, quietly (its typing is in recovered texts).
  useEffect(() => {
    if (pending || !view.deleted) return
    if (draft !== null) draft.onDeleted()
    else void navigate({ to: "/chats", replace: true })
  }, [navigate, pending, view.deleted, draft])
  // Pin the viewed branch even when it is currently the chat's default. The router's
  // location can advance before these props; an outgoing render must not undo the pick.
  useEffect(() => {
    const latestFork = router.latestLocation.search.fork
    if (
      router.latestLocation.pathname !== `/chats/${session.id}` ||
      (typeof latestFork === "string" && latestFork !== "" ? latestFork : null) !== fork
    )
      return
    if (
      !pending &&
      !session.snapshot().loading &&
      view.forkId === session.snapshot().forkId &&
      view.forkId !== null &&
      fork !== view.forkId
    )
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, fork: view.forkId }),
        replace: true,
        resetScroll: false
      })
  }, [navigate, router, session, fork, view.forkId, pending])
  // Rows read the cast from context: it's the same object until the cast changes.
  const cast = useMemo(() => castView(view.cast), [view.cast])
  /** Turning summaries on, which asks first what it costs. */
  const [enabling, setEnabling] = useState(false)
  /** The summary the panel opens at: one clicked on the rail, or none. */
  const [summaryFocus, setSummaryFocus] = usePlaceParam("summary", "")
  useSummariesOfUrl(session)
  const focus = summaryFocus || null
  const setFocus = useCallback((next: string | null) => setSummaryFocus(next ?? "", true), [setSummaryFocus])
  const { prefs } = useViewPrefs()
  const [rail] = useCoverageRail(view.lcm?.enabled === true)
  const [summariesInChat] = useSummariesInChat()
  const openSummaries = useCallback(
    (summaryId: string | null) => {
      setFocus(summaryId)
      show("summaries")
    },
    [show, setFocus]
  )
  // Another branch (DESIGN §3.2): the window opens the fork through it, at the message
  // switched to, which the URL then names, with the fork unless it's the current one.
  const [branchError, setBranchError] = useState<string | null>(null)
  const onBranch = useCallback(
    async (entry: PathEntry, index: number) => {
      const result = await session.switchBranch(entry, index)
      if (!result.ok) return setBranchError(result.error.message)
      setBranchError(null)
      const sibling = result.value.slotId
      const target = result.value.fork.id
      if (sibling === slot && target === session.snapshot().forkId) {
        reopen(sibling)
      } else
        void navigate({
          to: ".",
          search: withPanel({ fork: target, slot: sibling })
        })
    },
    [session, navigate, withPanel, slot, reopen]
  )
  // Panel navigation changes where the action navigates without replacing a timeline prop.
  const branchAction = useRef(onBranch)
  useLayoutEffect(() => {
    branchAction.current = onBranch
  }, [onBranch])
  const switchBranch = useCallback((entry: PathEntry, index: number) => void branchAction.current(entry, index), [])
  // A summary's range opens the window at its first message, as a link to that message does.
  const branchFork = view.forkId
  // Beside the chat the panel stays open; a phone's sheet closes to show the message.
  const jump = useCallback(
    (target: SlotId) => {
      if (!wide) rememberPanel(userId, null)
      const at = branchFork === null ? { slot: target } : { fork: branchFork, slot: target }
      if (target === slot) {
        if (!wide) show(null)
        reopen(target)
      } else
        void navigate({
          to: ".",
          search: wide ? withPanel(at) : at,
          // A message link starts a fresh reading position and explicitly closes a phone's sheet.
          state: ({ chatReading: _old, chatFlashed: _flashed, ...prev }) => ({ ...prev, chatPanel: true }),
          resetScroll: false
        })
    },
    [navigate, show, withPanel, wide, slot, branchFork, userId, reopen]
  )
  // Two chats side by side: the keys are the focused one's.
  const focused = useTabFocused()
  useChatCommandKeys({ session, view, onHistory: () => show("history"), onJump: jump }, focused)
  const title = chatDisplayName(view)
  const place = useSidePanelPlace(wide)
  const panelOpen = panel !== null && place.show
  const pictured = useChatPicture(view)
  useTabMeta(
    undefined,
    tabPortrait(
      castCharacters(view),
      pictured && view.chat ? { id: view.chat.id, name: title, mediaId: pictured } : null
    )
  )
  const kindRoot = kindRootProps(useChatKindLook(view.chat?.kind))
  // A kind without summaries (a workshop) isn't offered them when it outgrows its context.
  const summariesAllowed = summarizes(view.chat)
  return (
    <ChatSurfaceProviders session={session} cast={cast} view={view} wide={wide} onOpenPanel={show}>
      <CastContext value={cast}>
        {/* The chat's kind marks everything in it: a workshop's accent (spec/WORKSHOP.md §2.5). */}
        <div
          {...kindRoot}
          className="flex min-h-0 flex-1"
          style={
            {
              ...kindRoot.style,
              "--chat-portrait-width": `${{ small: 48, default: 60, large: 72, largest: 84 }[prefs.portraitSize]}px`
            } as CSSProperties
          }
        >
          <SlotOutlet slot={chatColumns} props={{ wide }} />
          <div ref={chatMain} data-chat-main tabIndex={-1} className="relative flex min-w-0 flex-1 flex-col">
            <ChatBackdrop
              prefs={prefs}
              chatId={started ? view.chat?.id : undefined}
              kind={view.chat?.kind}
              scene={view.cast?.background}
            />
            <ChatHeader
              session={session}
              view={view}
              onJump={jump}
              onHistory={() => show("history")}
              panel={{ userId, open: panel, wide, onToggle: (tab) => show(panel === tab ? null : tab) }}
            />
            {/* A chat that has outgrown its context with summaries off (spec/LCM.md §2.13): easy to turn on. */}
            {view.lcm !== null &&
              summariesAllowed &&
              !view.lcm.enabled &&
              view.lcm.leafSlotId === view.leafSlotId &&
              (view.history?.historyStart?.depth ?? 0) > 0 && (
                // One line, not a block: it stays while the chat is read for hours.
                <div
                  role="status"
                  className="chat-column flex items-center gap-2 border-b border-border px-2 pb-2 text-sm text-muted"
                >
                  {/* A phone's line has room for the gist only; the button says the rest. */}
                  <span className="min-w-0 flex-1 truncate">
                    <span className="sm:hidden">Summaries are off.</span>
                    <span className="hidden sm:inline">The oldest messages aren&rsquo;t sent: summaries are off.</span>
                  </span>
                  <Button
                    hint="Opens summary settings for this chat."
                    variant="ghost"
                    className="h-7 shrink-0 px-2 text-accent"
                    title="The oldest messages aren’t sent to the model. Summaries keep what happened in them in the context."
                    aria-description="The oldest messages aren’t sent to the model. Summaries keep what happened in them in the context."
                    onClick={() => setEnabling(true)}
                  >
                    Enable summaries
                  </Button>
                </div>
              )}
            {(view.error ?? branchError) && (
              <div className="chat-column">
                <Alert tone="danger">{view.error ?? branchError}</Alert>
              </div>
            )}
            {!view.loading && view.chat?.status === "pending" && view.entries.length === 0 && (
              <PendingIntro view={view} />
            )}
            {view.loading ? (
              // Takes the messages' place, so the composer is where it will stay.
              <SkeletonMessages onRetry={() => void session.open(slot ?? null)} />
            ) : (
              <MessageList
                // A replacement layer has different row coordinates. Give it fresh
                // virtualizer measurements rather than inheriting the old pixel anchor.
                key={summariesInChat ? "summaries" : "originals"}
                session={session}
                view={view}
                anchor={reading ? reading.slot : slot}
                jump={reading ? null : slot}
                flashes={flashes}
                restore={reading}
                beforeComposerSubmit={beforeComposerSubmit}
                rail={rail}
                onBranch={switchBranch}
                onOpenSummaries={openSummaries}
              />
            )}
            <SlotOutlet slot={chatComposerNotes} props={{ view, session }} />
            <SlotOutlet slot={chatComposer} props={{ session, view, onSettings: show, onBeforeSubmit }} />
            <SlotOutlet slot={chatOverlays} props={{ session, view }} />
          </div>
          {/* Mounted only while open: the surface re-renders with every page of history. */}
          {panelOpen && (
            <ChatSidePanel
              tab={panel}
              wide={wide}
              host={place.host}
              title={title}
              onTab={show}
              onClose={close}
              session={session}
              view={view}
              focus={focus}
              onSummaries={openSummaries}
              onJump={jump}
              onEnable={() => setEnabling(true)}
            />
          )}
        </div>
        {enabling && <EnableLcmDialog session={session} onOpenChange={setEnabling} />}
      </CastContext>
    </ChatSurfaceProviders>
  )
}

/**
 * A new chat with nothing in it yet (no greeting to show): what it is, where its messages
 * will be. Its first message starts it.
 */
function PendingIntro({ view }: { view: ChatView }) {
  const characters = castCharacters(view)
  return (
    <div className="chat-column pt-4">
      <p data-empty-chat-intro="" className="mx-3 rounded-lg bg-surface-raised px-3 py-2 text-sm text-muted">
        {characters.length === 0
          ? "A chat with no characters yet: for notes, or trying a model. Characters can join from the Cast tab. Your first message starts the chat."
          : `${characters.length === 1 ? `${characters[0]!.name} has no greeting.` : "None of them has a greeting."} Your first message starts the chat.`}
      </p>
    </div>
  )
}

/** /chats/$chatId, with `fork` for a fork other than the current one and `slot` for a message. */
export function ChatPage() {
  const { chatId } = useParams({ strict: false }) as { chatId: ChatId }
  const search = useSearch({ strict: false }) as { fork?: unknown; slot?: unknown; panel?: unknown }
  const fork = typeof search.fork === "string" && search.fork !== "" ? (search.fork as ForkId) : null
  const slot = typeof search.slot === "string" ? (search.slot as SlotId) : null
  const validPanel = useIsPanelTab(search.panel)
  usePlaceNotice(search.panel !== undefined && !validPanel ? "This panel is no longer available." : null)
  const panel = validPanel ? (search.panel as string) : null
  // A new chat started here before the start card's title reached it: that rename finishes now.
  const meant = useMemo(() => meantTitle(chatId)?.titleKey ?? null, [chatId])
  return (
    <div data-fill className="flex min-h-0 flex-1 flex-col">
      {meant !== null && <FinishMeantTitle key={chatId} chatId={chatId} titleKey={meant} />}
      <OpenChat chatId={chatId} fork={fork} slot={slot} panel={panel} />
    </div>
  )
}
