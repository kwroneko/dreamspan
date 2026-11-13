// The timeline's row where threads part (spec/THREADS.md §13.3; `timeline.threads`), after S:
// "Parallel threads from here: At the Lantern (this one) · At the docks", each name a link
// (a middle-click opens it in a new tab), and the set's Undo, a divider as the summaries' is.
import type { ThreadSet } from "@rp/shared/threads.ts"
import { Link } from "@tanstack/react-router"
import { Fragment } from "react"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { openOnPlainClick } from "../../ui/links.ts"
import { useCast } from "../chat/cast.ts"
import type { ChatSession } from "../chat/session.ts"
import { forkSearch, useOpenFork, usePanel, useUndoThreads } from "./actions.ts"
import { splitNumber, threadName } from "./model.ts"
import { UNDO_HINT } from "./ThreadsSection.tsx"

const ROW_HINT = "These threads run at the same time. Each goes on by itself until you join them."

export function ThreadsTimelineRow({ session, set }: { session: ChatSession; set: ThreadSet }) {
  const cast = useCast()
  const panel = usePanel()
  const openFork = useOpenFork()
  const undo = useUndoThreads()
  const chat = session.snapshot().chat
  return (
    <div data-threads-row={set.splitId} className="flex w-full items-center gap-3 py-2">
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
      <div className="flex max-w-full min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-muted">
        <Tooltip label={ROW_HINT}>
          <span
            tabIndex={0}
            className="inline-flex items-center gap-1 rounded-md px-1 font-medium outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon name="threads" size={14} className="shrink-0" />
            Parallel threads from here:
          </span>
        </Tooltip>
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {set.threads.map((thread, index) => {
            const name = threadName(thread, (id) => cast.cards.get(id)?.name ?? null)
            const self = thread.ordinal === set.self
            return (
              <Fragment key={thread.ordinal}>
                {index > 0 && " · "}
                {self || thread.openForkId === null ? (
                  <span className={self ? "text-text" : ""}>
                    {name}
                    {self ? " (this one)" : ""}
                  </span>
                ) : (
                  <Tooltip label={`Opens “${name}”. A middle-click opens it in a new tab.`}>
                    <Link
                      to="/chats/$chatId"
                      params={{ chatId: session.id }}
                      search={forkSearch(chat, thread.openForkId, panel)}
                      data-thread-link={thread.ordinal}
                      onClick={openOnPlainClick(() => openFork(session, thread.openForkId!))}
                      className="rounded text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      {name}
                    </Link>
                  </Tooltip>
                )}
              </Fragment>
            )
          })}
        </span>
        <Button
          variant="ghost"
          hint={UNDO_HINT}
          aria-label={`Undo starting the threads from ${splitNumber(set)}`}
          className="h-7! px-2!"
          onClick={() =>
            void undo(session, {
              splitId: set.splitId,
              forkId: set.forkId,
              removed: set.threads.filter((thread) => thread.starts).map((thread) => thread.forkId)
            })
          }
        >
          Undo
        </Button>
      </div>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
    </div>
  )
}
