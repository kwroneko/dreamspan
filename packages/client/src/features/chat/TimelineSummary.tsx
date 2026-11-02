// The selected layer in the timeline, with lazy, recursive expansion. ReadPath stays
// paged even for an imported summary spanning thousands of original messages.
import { positionOf } from "./position.ts"
import type { PathEntry, SlotId } from "@rp/shared/chat.ts"
import type { LcmSummary, Summary } from "@rp/shared/lcm.ts"
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Markdown } from "../../ui/Markdown.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { rangeText, tokensText } from "./lcm.ts"
import type { ChatSession } from "./session.ts"
import { LevelBadge, SummaryBadges } from "./summaryParts.tsx"

type Row = Pick<
  LcmSummary,
  | "id"
  | "level"
  | "from"
  | "to"
  | "content"
  | "fresh"
  | "firstSlotId"
  | "lastSlotId"
  | "revisionId"
  | "origin"
  | "status"
  | "tokens"
>

interface Expansion {
  readonly target: PathEntry | null
  readonly open: boolean
}
/** Which summaries the viewer opened, and at which link, per chat session. */
const remembered = new WeakMap<ChatSession, Map<string, Expansion>>()
const expansions = (session: ChatSession) => {
  let map = remembered.get(session)
  if (!map) remembered.set(session, (map = new Map()))
  return map
}

export function TimelineSummary({
  session,
  summary,
  renderMessage,
  target: linked = null,
  onOpen
}: {
  session: ChatSession
  summary: Row
  target?: PathEntry | null
  renderMessage: (entry: PathEntry) => ReactNode
  /** Opens this summary in the Summaries tab. */
  onOpen?: (summaryId: string) => void
}) {
  // A new message link reveals its original even if this summary was collapsed. The link's
  // message stays the one shown when the window it was read in moves on (a later page read
  // around the anchor, a refresh): losing it mustn't fold the summary away under the reader.
  // The choice outlives this row's mount: the list drops rows scrolled far off and mounts them
  // again, and a summary folded by hand must come back folded, not reopened by its link.
  const [expansion, setLocal] = useState<Expansion>(() => {
    const was = expansions(session).get(summary.id)
    return was && (linked === null || was.target?.slotId === linked.slotId)
      ? was
      : { target: linked, open: linked !== null }
  })
  const setExpansion = (next: Expansion) => {
    expansions(session).set(summary.id, next)
    setLocal(next)
  }
  if (linked !== null && linked.slotId !== expansion.target?.slotId) setExpansion({ target: linked, open: true })
  const target = expansion.target
  const targetId = target?.slotId ?? null
  const open = expansion.open
  const pathRevision = useSyncExternalStore(session.subscribe, () => session.snapshot().pathRevision)
  // Keep every page already expanded when an edit, swipe, hide or reconnect invalidates it.
  const loaded = useRef<{ first: number; last: SlotId; targetId: SlotId | null } | null>(null)
  // Advances whenever a read starts or replaces the rows: a page response from before
  // (another link's window, or rows since refreshed) mustn't land in the current rows.
  const generation = useRef(0)
  const [children, setChildren] = useState<ReadonlyArray<Summary> | null>(null)
  const [messages, setMessages] = useState<ReadonlyArray<PathEntry> | null>(null)
  const [before, setBefore] = useState<PathEntry["slotId"] | null>(null)
  const [after, setAfter] = useState<SlotId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [retry, setRetry] = useState(0)
  const range = rangeText(summary.from, summary.to)

  useEffect(() => {
    if (!open) return
    let live = true
    generation.current++
    const load = async () => {
      setError(null)
      if (summary.level > 1) {
        const result = await session.call((client) =>
          client("GetSummary", { forkId: session.snapshot().forkId, summaryId: summary.id })
        )
        if (!live) return
        if (!result.ok) return setError(result.error.message)
        const results = await Promise.all(
          result.value.children.map(async (child) => {
            const current = await session.call((client) =>
              client("GetSummary", { forkId: session.snapshot().forkId, summaryId: child.summaryId })
            )
            if (!current.ok || current.value.revisionId === child.revisionId) return current
            // Condensation pins its inputs. An edit of a child must not rewrite what
            // this parent actually condensed when the user expands its provenance.
            const revisions = await session.call((client) =>
              client("ListSummaryRevisions", { forkId: session.snapshot().forkId, summaryId: child.summaryId })
            )
            if (!revisions.ok) return revisions
            const pinned = revisions.value.find((revision) => revision.id === child.revisionId)
            if (!pinned) return { ok: false as const, error: { message: "The condensed revision is unavailable." } }
            return {
              ok: true as const,
              value: {
                ...current.value,
                content: pinned.content,
                tokens: pinned.tokens,
                revisionId: pinned.id,
                revisionNumber: pinned.number,
                fresh: false
              }
            }
          })
        )
        if (!live) return
        const failed = results.find((r) => !r.ok)
        if (failed && !failed.ok) return setError(failed.error.message)
        setChildren(results.flatMap((r) => (r.ok ? [r.value] : [])))
      } else {
        const previous = loaded.current?.targetId === targetId ? loaded.current : null
        const rows: PathEntry[] = []
        let from = previous?.last ?? summary.lastSlotId
        let firstPage = true
        let older: SlotId | null = null
        do {
          const result = await session.call((client) =>
            client("ReadPath", {
              chatId: session.id,
              leafSlotId: summary.lastSlotId,
              range:
                firstPage && previous === null && targetId !== null
                  ? { _tag: "Around", slot: targetId }
                  : { _tag: "Older", from },
              limit: 100
            })
          )
          if (!live) return
          if (!result.ok) return setError(result.error.message)
          rows.unshift(
            ...result.value.entries.filter((e) => positionOf(e) >= summary.from - 1 && positionOf(e) < summary.to)
          )
          older =
            (result.value.entries[0] ? positionOf(result.value.entries[0]) : -1) > summary.from - 1
              ? result.value.older
              : null
          if (older === null || previous === null || (rows[0] ? positionOf(rows[0]) : -1) <= previous.first) break
          from = older
          firstPage = false
        } while (true)
        const first = rows[0]
        const last = rows.at(-1)
        if (first && last) loaded.current = { first: positionOf(first), last: last.slotId, targetId }
        generation.current++
        setMessages(rows)
        setBefore(older)
        // A refresh reads backwards from the last loaded original, so its window has no
        // forward cursor of its own; the next page starts after that original either way.
        setAfter(last && positionOf(last) < summary.to - 1 ? last.slotId : null)
      }
    }
    void load()
    return () => {
      live = false
    }
  }, [
    session,
    summary.id,
    summary.revisionId,
    summary.level,
    summary.from,
    summary.to,
    summary.lastSlotId,
    open,
    retry,
    pathRevision,
    targetId
  ])

  const page = async (direction: "earlier" | "later") => {
    const from = direction === "earlier" ? before : after
    if (from === null) return
    const revision = session.snapshot().pathRevision
    const current = generation.current
    setPending(true)
    const result = await session.call((client) =>
      client("ReadPath", {
        chatId: session.id,
        leafSlotId: summary.lastSlotId,
        range: direction === "earlier" ? { _tag: "Older", from } : { _tag: "Newer", after: from },
        limit: 100
      })
    )
    // Pending disables both buttons, so this is the only page request in flight.
    setPending(false)
    if (generation.current !== current || session.snapshot().pathRevision !== revision) return
    if (!result.ok) return setError(result.error.message)
    const entries = result.value.entries.filter((e) => positionOf(e) >= summary.from - 1 && positionOf(e) < summary.to)
    const bounds = loaded.current
    if (bounds && entries.length > 0) {
      if (direction === "earlier") bounds.first = positionOf(entries[0]!)
      else bounds.last = entries.at(-1)!.slotId
    }
    setMessages((rows) => (direction === "earlier" ? [...entries, ...(rows ?? [])] : [...(rows ?? []), ...entries]))
    if (direction === "earlier")
      setBefore(
        (result.value.entries[0] ? positionOf(result.value.entries[0]) : -1) > summary.from - 1
          ? result.value.older
          : null
      )
    else
      setAfter(
        (result.value.entries.at(-1) ? positionOf(result.value.entries.at(-1)!) : summary.to) < summary.to - 1
          ? result.value.newer
          : null
      )
  }
  const section = useRef<HTMLElement>(null)
  const toggle = () => setExpansion({ target, open: !open })
  // Folding from the end of a long expansion brings the summary back into view. Its header
  // stays where it was in the list; the list itself keeps its distance from the end as a row
  // above shrinks, and may drop the row meanwhile, so the scroll position is set on the list.
  const collapseFromEnd = () => {
    const element = section.current
    let list = element?.parentElement ?? null
    while (list && !/(auto|scroll)/.test(getComputedStyle(list).overflowY)) list = list.parentElement
    const at =
      element && list
        ? list.scrollTop + element.getBoundingClientRect().top - list.getBoundingClientRect().top - 8
        : null
    toggle()
    if (list === null || at === null) return
    // Held for a moment, while the list measures the rows around it again; the reader
    // scrolling takes over at once.
    const scroller = list
    const until = performance.now() + 800
    let held = true
    const release = () => {
      held = false
      for (const event of inputs) scroller.removeEventListener(event, release)
    }
    const inputs = ["wheel", "touchmove", "keydown", "pointerdown"] as const
    for (const event of inputs) scroller.addEventListener(event, release, { passive: true })
    const hold = () => {
      if (!held) return
      if (Math.abs(scroller.scrollTop - Math.max(0, at)) > 2) scroller.scrollTop = Math.max(0, at)
      if (performance.now() < until) requestAnimationFrame(hold)
      else release()
    }
    requestAnimationFrame(hold)
  }
  const what = summary.level > 1 ? "the summaries it condenses" : "its messages"
  return (
    <section
      ref={section}
      data-timeline-summary={summary.id}
      data-level={summary.level}
      aria-label={`Level ${summary.level} summary: ${range}`}
      className="flex flex-col gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2"
    >
      <div className="flex items-start gap-1">
        <Tooltip label={open ? `Hide ${what}` : `Show ${what}`}>
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${range.toLowerCase()}`}
            onClick={toggle}
            className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-1 py-1 text-left text-sm outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon
              name="right"
              size={14}
              className={`text-muted transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
            />
            <span className="font-medium">{range}</span>
            <span className="text-xs text-muted">{tokensText(summary.tokens)}</span>
          </button>
        </Tooltip>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1 py-1">
          <LevelBadge level={summary.level} />
          <SummaryBadges summary={summary} />
        </div>
        {onOpen && (
          <IconButton
            icon="summary"
            label={`Open the summary of ${range.toLowerCase()} in the Summaries tab`}
            hint="Open in the Summaries tab: edit, revisions, re-summarize"
            onClick={() => onOpen(summary.id)}
          />
        )}
      </div>
      <Markdown text={summary.content ?? ""} streaming={false} />
      {open && (
        <div
          role="region"
          aria-label={`Contents of ${range.toLowerCase()}`}
          className="flex min-w-0 flex-col gap-2 border-l-2 border-accent/40 pl-2"
        >
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error} <Button onClick={() => setRetry(retry + 1)}>Retry</Button>
            </p>
          )}
          {summary.level > 1 ? (
            children === null ? (
              !error && <p className="text-sm text-muted">Loading summaries…</p>
            ) : (
              children.map((child) => (
                <TimelineSummary
                  key={child.id}
                  session={session}
                  summary={child}
                  renderMessage={renderMessage}
                  {...(onOpen ? { onOpen } : {})}
                  target={
                    target && positionOf(target) >= child.from - 1 && positionOf(target) < child.to ? target : null
                  }
                />
              ))
            )
          ) : messages === null ? (
            !error && <p className="text-sm text-muted">Loading messages…</p>
          ) : (
            <>
              {before !== null && (
                <Tooltip label="Show the 100 messages before these, inside this summary.">
                  <Button className="self-center" pending={pending} onClick={() => void page("earlier")}>
                    Earlier messages
                  </Button>
                </Tooltip>
              )}
              {messages.map((entry) => (
                <div key={entry.slotId}>{renderMessage(entry)}</div>
              ))}
              {after !== null && (
                <Tooltip label="Show the 100 messages after these, inside this summary.">
                  <Button className="self-center" pending={pending} onClick={() => void page("later")}>
                    Later messages
                  </Button>
                </Tooltip>
              )}
            </>
          )}
          <Tooltip label={`Hide ${what} again`}>
            <Button variant="ghost" className="h-7 self-start px-2 text-xs" onClick={collapseFromEnd}>
              <Icon name="down" size={14} className="rotate-180" />
              Collapse {range.toLowerCase()}
            </Button>
          </Tooltip>
        </div>
      )}
    </section>
  )
}
