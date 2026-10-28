// The selected layer in the timeline, with lazy, recursive expansion. ReadPath stays
// paged even for an imported summary spanning thousands of original messages.
import type { PathEntry, SlotId } from "@rp/shared/chat.ts"
import type { LcmSummary, Summary } from "@rp/shared/lcm.ts"
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { Markdown } from "../../ui/Markdown.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { rangeText } from "./lcm.ts"
import type { ChatSession } from "./session.ts"

type Row = Pick<
  LcmSummary,
  "id" | "level" | "from" | "to" | "content" | "fresh" | "firstSlotId" | "lastSlotId" | "revisionId"
>

export function TimelineSummary({
  session,
  summary,
  renderMessage,
  target = null
}: {
  session: ChatSession
  summary: Row
  target?: PathEntry | null
  renderMessage: (entry: PathEntry) => ReactNode
}) {
  const targetId = target?.slotId ?? null
  const [expansion, setExpansion] = useState({ targetId, open: targetId !== null })
  // A new message link reveals its original even if this summary was collapsed.
  if (expansion.targetId !== targetId) setExpansion({ targetId, open: targetId !== null })
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
          rows.unshift(...result.value.entries.filter((e) => e.depth >= summary.from - 1 && e.depth < summary.to))
          older = (result.value.entries[0]?.depth ?? -1) > summary.from - 1 ? result.value.older : null
          if (older === null || previous === null || (rows[0]?.depth ?? -1) <= previous.first) break
          from = older
          firstPage = false
        } while (true)
        const first = rows[0]
        const last = rows.at(-1)
        if (first && last) loaded.current = { first: first.depth, last: last.slotId, targetId }
        generation.current++
        setMessages(rows)
        setBefore(older)
        // A refresh reads backwards from the last loaded original, so its window has no
        // forward cursor of its own; the next page starts after that original either way.
        setAfter(last && last.depth < summary.to - 1 ? last.slotId : null)
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
    const entries = result.value.entries.filter((e) => e.depth >= summary.from - 1 && e.depth < summary.to)
    const bounds = loaded.current
    if (bounds && entries.length > 0) {
      if (direction === "earlier") bounds.first = entries[0]!.depth
      else bounds.last = entries.at(-1)!.slotId
    }
    setMessages((rows) => (direction === "earlier" ? [...entries, ...(rows ?? [])] : [...(rows ?? []), ...entries]))
    if (direction === "earlier")
      setBefore((result.value.entries[0]?.depth ?? -1) > summary.from - 1 ? result.value.older : null)
    else setAfter((result.value.entries.at(-1)?.depth ?? summary.to) < summary.to - 1 ? result.value.newer : null)
  }
  return (
    <section
      data-timeline-summary={summary.id}
      data-level={summary.level}
      aria-label={`Level ${summary.level} summary: ${range}`}
      className="flex flex-col gap-3 rounded-md border border-accent/40 bg-accent/5 p-3"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="accent">Level {summary.level}</Badge>
        <span className="font-medium">{range}</span>
        {!summary.fresh && <Badge tone="warning">Stale</Badge>}
      </div>
      <Markdown text={summary.content ?? ""} streaming={false} />
      <Button
        variant="ghost"
        className="self-start"
        aria-expanded={open}
        onClick={() => setExpansion({ targetId, open: !open })}
      >
        {open ? "Collapse" : summary.level > 1 ? "Expand to summaries" : "Expand to messages"}
      </Button>
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
                  target={target && target.depth >= child.from - 1 && target.depth < child.to ? target : null}
                />
              ))
            )
          ) : messages === null ? (
            !error && <p className="text-sm text-muted">Loading messages…</p>
          ) : (
            <>
              {before !== null && (
                <Button pending={pending} onClick={() => void page("earlier")}>
                  Load earlier messages in this summary
                </Button>
              )}
              {messages.map((entry) => (
                <div key={entry.slotId}>{renderMessage(entry)}</div>
              ))}
              {after !== null && (
                <Button pending={pending} onClick={() => void page("later")}>
                  Load later messages in this summary
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
