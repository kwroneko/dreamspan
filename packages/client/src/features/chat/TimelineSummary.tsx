// The selected layer in the timeline, with lazy, recursive expansion. ReadPath stays
// paged even for an imported summary spanning thousands of original messages.
import type { PathEntry } from "@rp/shared/chat.ts"
import type { LcmSummary, Summary } from "@rp/shared/lcm.ts"
import { type ReactNode, useEffect, useState } from "react"
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
  renderMessage
}: {
  session: ChatSession
  summary: Row
  renderMessage: (entry: PathEntry) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<ReadonlyArray<Summary> | null>(null)
  const [messages, setMessages] = useState<ReadonlyArray<PathEntry> | null>(null)
  const [before, setBefore] = useState<PathEntry["slotId"] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [retry, setRetry] = useState(0)
  const range = rangeText(summary.from, summary.to)

  useEffect(() => {
    if (!open) return
    let live = true
    const load = async () => {
      setError(null)
      if (summary.level > 1) {
        const result = await session.call((client) => client("GetSummary", { summaryId: summary.id }))
        if (!live) return
        if (!result.ok) return setError(result.error.message)
        const results = await Promise.all(
          result.value.children.map(async (child) => {
            const current = await session.call((client) => client("GetSummary", { summaryId: child.summaryId }))
            if (!current.ok || current.value.revisionId === child.revisionId) return current
            // Condensation pins its inputs. An edit of a child must not rewrite what
            // this parent actually condensed when the user expands its provenance.
            const revisions = await session.call((client) =>
              client("ListSummaryRevisions", { summaryId: child.summaryId })
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
        const result = await session.call((client) =>
          client("ReadPath", {
            chatId: session.id,
            leafSlotId: summary.lastSlotId,
            range: { _tag: "Older", from: summary.lastSlotId },
            limit: 100
          })
        )
        if (!live) return
        if (!result.ok) return setError(result.error.message)
        setMessages(result.value.entries.filter((e) => e.depth >= summary.from - 1 && e.depth < summary.to))
        setBefore((result.value.entries[0]?.depth ?? -1) > summary.from - 1 ? result.value.older : null)
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
    retry
  ])

  const earlier = async () => {
    if (before === null) return
    setPending(true)
    const result = await session.call((client) =>
      client("ReadPath", {
        chatId: session.id,
        leafSlotId: summary.lastSlotId,
        range: { _tag: "Older", from: before },
        limit: 100
      })
    )
    setPending(false)
    if (!result.ok) return setError(result.error.message)
    setMessages((rows) => [...result.value.entries.filter((e) => e.depth >= summary.from - 1), ...(rows ?? [])])
    setBefore((result.value.entries[0]?.depth ?? -1) > summary.from - 1 ? result.value.older : null)
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
      <Button variant="ghost" className="self-start" aria-expanded={open} onClick={() => setOpen(!open)}>
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
                <TimelineSummary key={child.id} session={session} summary={child} renderMessage={renderMessage} />
              ))
            )
          ) : messages === null ? (
            !error && <p className="text-sm text-muted">Loading messages…</p>
          ) : (
            <>
              {before !== null && (
                <Button pending={pending} onClick={() => void earlier()}>
                  Load earlier messages in this summary
                </Button>
              )}
              {messages.map((entry) => (
                <div key={entry.slotId}>{renderMessage(entry)}</div>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  )
}
