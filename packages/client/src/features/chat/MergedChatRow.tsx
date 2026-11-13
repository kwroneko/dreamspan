// A merged chat's entry in the timeline (spec/CHAT-MERGE.md §7): one row, "Merged “<title>” ·
// N messages", that opens to the messages it brought in, read-only and paged, with a link to the
// chat they came from. The copy is frozen at the merge: the other chat can change or go. Another
// thread of this chat joined here reads "Joined “At the docks”" (spec/THREADS.md §7.1).
import type { BinItem } from "@rp/shared/bin.ts"
import type { PathEntry } from "@rp/shared/chat.ts"
import type { MergedMessage, MergeInfo } from "@rp/shared/mergeApi.ts"
import { Link } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Spinner } from "../../ui/Spinner.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import { MessageActions } from "./messageActions.tsx"
import type { ChatSession, Outcome } from "./session.ts"

const PAGE = 50

const included = {
  verbatim: null,
  summarized: "Read through a summary",
  left_out: "Not read by the model"
} as const

export function MergedChatRow({ entry, session }: { entry: PathEntry; session: ChatSession }) {
  const [info, setInfo] = useState<MergeInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ReadonlyArray<MergedMessage>>([])
  const [done, setDone] = useState(false)
  const started = useRef(false)
  const [error, setError] = useState<AppError | null>(null)
  const reader = useAction()
  const pager = useAction()
  const deleted = useDeletedToast()
  useEffect(() => {
    let live = true
    void reader
      .run((client) => client("GetMerge", { chatId: session.id, slotId: entry.slotId }))
      .then((result) => {
        if (live && result.ok) setInfo(result.value)
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, entry.slotId])
  const more = async () => {
    if (!info) return
    const result = await pager.run((client) =>
      client("MergeMessages", { chatId: session.id, mergeId: info.id, offset: messages.length, limit: PAGE })
    )
    if (!result.ok) return
    setMessages((shown) => [...shown, ...result.value])
    if (result.value.length < PAGE) setDone(true)
  }
  const toggle = () => setOpen((shown) => !shown)
  // The first page once it's open and the merge is known, whichever comes last.
  const mergeId = info?.id ?? null
  useEffect(() => {
    if (!open || mergeId === null || started.current) return
    started.current = true
    void more()
    // `more` reads the current state; it runs once per row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mergeId])
  const report = (outcome: Outcome<unknown>) => setError(outcome.ok ? null : outcome.error)
  const toast = (outcome: Outcome<BinItem>) => {
    report(outcome)
    if (outcome.ok) deleted(outcome.value)
  }
  const hidden = entry.contextExcluded
  const context = {
    entry,
    session,
    branchFork: session.snapshot().forkId,
    generated: false,
    generating: false,
    hidden,
    report,
    toast
  }
  const thread = info?.thread === true
  const title = info?.title ?? "another chat"
  const count = info ? info.messages : null
  const what = thread ? "thread" : "chat"
  return (
    <article
      aria-label={thread ? `Joined thread “${title}”` : `Merged chat “${title}”`}
      data-slot={entry.slotId}
      data-merge
      data-hidden={hidden || undefined}
      className="group flex min-w-0 flex-col gap-1 rounded-lg border border-dashed border-border px-3 py-2"
    >
      <header className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Tooltip
          label={
            thread
              ? open
                ? "Click to hide the joined thread's messages."
                : "Click to show the messages the joined thread brought in."
              : open
                ? "Click to hide the merged messages."
                : "Click to show the merged messages."
          }
        >
          <button
            type="button"
            aria-expanded={open}
            onClick={toggle}
            className="flex min-w-0 items-center gap-2 rounded-md py-1 text-left font-medium outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon name={thread ? "threads" : "merge"} size={16} />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {thread ? "Joined" : "Merged"} “{title}”
              {count === null ? "" : ` · ${count.toLocaleString()} ${count === 1 ? "message" : "messages"}`}
            </span>
          </button>
        </Tooltip>
        {hidden && <Badge tone="neutral">Hidden</Badge>}
        {info?.sourceLive && info.sourceChatId && (
          <Tooltip label={`Opens “${title}”, the ${what} these messages came from.`}>
            <Link
              to="/chats/$chatId"
              params={{ chatId: info.sourceChatId }}
              search={info.sourceForkId ? { fork: info.sourceForkId } : {}}
              className="text-sm text-accent underline"
            >
              Open “{title}”
            </Link>
          </Tooltip>
        )}
        {info && !info.sourceLive && <span className="text-xs text-muted">The {what} it came from is gone</span>}
        <MessageActions context={context} className="ml-auto flex justify-end" />
      </header>
      {info && (
        <p className="text-xs text-muted">
          {[
            info.cast.length > 0 && `With ${info.cast.join(", ")}`,
            info.summarized > 0 && `${info.summarized.toLocaleString()} read through summaries`,
            info.leftOut > 0 && `${info.leftOut.toLocaleString()} not read by the model`
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {open && (
        <ol aria-label={`Messages of “${title}”`} className="flex min-w-0 flex-col gap-2 border-l-2 border-border pl-3">
          {messages.map((message) => (
            <li key={message.ordinal} className="flex min-w-0 flex-col gap-0.5 text-sm">
              <span className="flex flex-wrap items-center gap-2 font-semibold">
                {message.kind === "summary" ? "Summary" : message.speakerName}
                {message.kind === "message" && included[message.included] && (
                  <span className="text-xs font-normal text-muted">{included[message.included]}</span>
                )}
              </span>
              <p className="whitespace-pre-wrap text-text [overflow-wrap:anywhere]">{message.content}</p>
            </li>
          ))}
          {pager.pending && (
            <li className="flex items-center gap-2 text-sm text-muted">
              <Spinner /> Loading…
            </li>
          )}
          {!pager.pending && !done && messages.length > 0 && (
            <li>
              <Button hint="Shows the next merged messages." onClick={() => void more()}>
                Show more
              </Button>
            </li>
          )}
        </ol>
      )}
      <ErrorAlert error={error ?? pager.error} />
    </article>
  )
}
