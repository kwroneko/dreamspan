// A message sent to several threads, afterwards (spec/THREADS.md §6.3): each copy is an ordinary
// message of its thread, and the group only prompts. The header's "Also in At the docks" links
// to the other copy; an edit offers "Save in both" beside "Save here", amending each copy in its
// own thread as an edit there would; a delete's toast offers to delete the other copy too.
import type { BinItem } from "@rp/shared/bin.ts"
import type { EntityId, PathEntry, SlotId } from "@rp/shared/chat.ts"
import type { ThreadSet } from "@rp/shared/threads.ts"
import { Link } from "@tanstack/react-router"
import { Fragment } from "react"
import { Button } from "../../ui/Button.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { listNames, useCast } from "../chat/cast.ts"
import type { DeleteOfferContext } from "../chat/messageActions.tsx"
import type { MessageDetailProps } from "../chat/messageDetails.tsx"
import type { ChatSession } from "../chat/session.ts"
import { forkSearch, usePanel } from "./actions.ts"
import { ownThread, threadName } from "./model.ts"
import { threadSetsNow, useThreadSetsOf, useThreadsVersion } from "./threadSets.ts"

type Copy = NonNullable<PathEntry["copies"]>[number]

/** The name of the thread with sets `sets` (its innermost set's), once they're read. */
const copyThread = (sets: ReadonlyArray<ThreadSet> | null | undefined, nameOf: (id: EntityId) => string | null) => {
  const set = sets?.[0]
  const thread = set && ownThread(set)
  return thread ? threadName(thread, nameOf) : "another thread"
}

/** The copies' thread names, read as the header shows them. */
const useCopyNames = (session: ChatSession, copies: ReadonlyArray<Copy>) => {
  const view = session.snapshot()
  const version = useThreadsVersion(session, view)
  const cast = useCast()
  // Names come from the sets this returns, never read beside it: the compiler memoizes on what's passed.
  const sets = useThreadSetsOf(
    session,
    view.chat?.id ?? null,
    copies.map((copy) => copy.forkId),
    version
  )
  const nameOf = (id: EntityId) => cast.cards.get(id)?.name ?? null
  return copies.map((copy) => copyThread(sets.get(copy.forkId), nameOf))
}

/** "Also in At the docks", in the message's header: a link to each copy in its thread. */
export function AlsoIn({ entry, session }: MessageDetailProps) {
  // Nearly every message has no copy: it reads nothing and listens to nothing.
  return entry.copies === undefined ? null : <AlsoInLinks session={session} copies={entry.copies} />
}

function AlsoInLinks({ session, copies }: { session: ChatSession; copies: ReadonlyArray<Copy> }) {
  const names = useCopyNames(session, copies)
  const panel = usePanel()
  const chat = session.snapshot().chat
  return (
    <span data-also-in className="min-w-0 text-xs text-muted [overflow-wrap:anywhere]">
      Also in{" "}
      {copies.map((copy, index) => (
        <Fragment key={copy.slotId}>
          {index > 0 && ", "}
          <Tooltip
            label={`This message went to “${names[index]}” too. Opens it there; a middle-click opens a new tab.`}
          >
            <Link
              to="/chats/$chatId"
              params={{ chatId: session.id }}
              search={{ ...forkSearch(chat, copy.forkId, panel), slot: copy.slotId }}
              className="rounded text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
            >
              {names[index]}
            </Link>
          </Tooltip>
        </Fragment>
      ))}
    </span>
  )
}

/** Amends copy `copy` to `content` in its own thread, as an edit there would. */
const amendCopy = async (session: ChatSession, copy: Copy, content: string) => {
  const read = await session.call((client) =>
    client("ReadPath", {
      chatId: session.id,
      forkId: copy.forkId,
      leafSlotId: copy.slotId,
      range: { _tag: "Bottom" },
      limit: 1
    })
  )
  if (!read.ok) return read
  const entry = read.value.entries.at(-1)
  if (entry === undefined || entry.slotId !== copy.slotId)
    return { ok: false as const, error: { tag: "NotFound", message: "That copy is gone." } }
  const { version } = entry
  if (version.content === content) return { ok: true as const, value: null }
  return version.writer === "human" && version.status !== "generating"
    ? session.call((client) =>
        client("AmendVersion", {
          versionId: version.id,
          forkId: copy.forkId,
          content,
          expectedRowVersion: version.rowVersion
        })
      )
    : session.call((client) =>
        client("EditVersion", {
          slotId: copy.slotId,
          forkId: copy.forkId,
          sourceVersionId: version.id,
          content,
          expectedRowVersion: entry.rowVersion
        })
      )
}

/** "Save in both" (or "in all 3"), beside the edit's "Save here". */
export function SaveInAll({
  entry,
  session,
  disabled,
  save
}: {
  entry: PathEntry
  session: ChatSession
  disabled: boolean
  save: (after: (text: string) => Promise<void>) => void
}) {
  const copies = entry.copies ?? []
  const names = useCopyNames(session, copies)
  const label = copies.length === 1 ? "Save in both" : `Save in all ${copies.length + 1}`
  return (
    <Button
      type="button"
      disabled={disabled}
      hint={`Saves this text here and in ${listNames(names.map((name) => `“${name}”`))}, where this message went too.`}
      onClick={() =>
        save(async (text) => {
          const results = await Promise.all(copies.map((copy) => amendCopy(session, copy, text)))
          const failed = names.filter((_, index) => !results[index]!.ok)
          if (failed.length > 0)
            showToast({
              title: `Not saved in ${listNames(failed.map((name) => `“${name}”`))}`,
              description: "That copy changed or went since. Edit it there."
            })
          else showToast({ title: `Saved in ${listNames(names.map((name) => `“${name}”`))} too` })
        })
      }
    >
      {label}
    </Button>
  )
}

/** The delete toast's "Delete the copy in “At the docks” too", for a message deleted whole. */
export const copyDeleteActions = ({ entry, session, deleted }: DeleteOfferContext, item: BinItem) => {
  if (item.kind !== "message") return []
  const cast = session.snapshot().cast
  const nameOf = (id: EntityId) => cast?.cards.find((card) => card.entityId === id)?.name ?? null
  return (entry.copies ?? []).map((copy) => {
    const name = copyThread(threadSetsNow(session.id, copy.forkId), nameOf)
    return {
      label: `Delete the copy in “${name}” too`,
      hint: `Moves the copy of this message in “${name}” to the bin as well.`,
      onClick: () =>
        void session
          .call((client) => client("DeleteMessage", { slotId: copy.slotId as SlotId, forkId: copy.forkId }))
          .then((result) => {
            if (result.ok) deleted(result.value)
            else showToast({ title: "Couldn't delete the copy", description: result.error.message })
          })
    }
  })
}
