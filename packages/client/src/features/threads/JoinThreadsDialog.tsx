// Joining threads (spec/THREADS.md §7.1): the merge dialog in its thread mode, from a message's
// "Join a thread here…" (after it) or ⋯ "Join threads…" (after the newest). Its picker lists the
// other threads of every set this fork is in, innermost first, each with its characters and what
// joining it brings ("10 messages since #40", "3 new since the last join"); several can be ticked.
import type { EntityId } from "@rp/shared/chat.ts"
import type { ChatMergePreview } from "@rp/shared/mergeApi.ts"
import { useEffect, useState, useSyncExternalStore } from "react"
import { Avatar } from "../../ui/Avatar.tsx"
import { Checkbox } from "../../ui/Choice.tsx"
import { useCast } from "../chat/cast.ts"
import type { ChatCommandDialogProps } from "../chat/commands.tsx"
import { MergeChatDialog, type MergeSource, type MergeSourcePickerProps } from "../chat/MergeChatDialog.tsx"
import type { MessageActionProps } from "../chat/messageActions.tsx"
import type { ChatView } from "../chat/session.ts"
import { splitNumber, threadName } from "./model.ts"
import { type Offered, otherThreads } from "./sendTargets.ts"
import { shownForkOf, threadSetsNow, useThreadSets } from "./threadSets.ts"

export const JOIN_HINT =
  "Brings another thread's messages since the threads parted into this one, as one entry. Its characters are here again from there on."

/** Offered while another thread of a set this fork is in has something not yet joined here. */
export const joinOffered = (view: ChatView) => {
  const shown = shownForkOf(view)
  if (view.chat === null || shown === null) return false
  return otherThreads(threadSetsNow(view.chat.id, shown) ?? [], shown).some(
    (other) => other.thread.joined?.upToDate !== true
  )
}

const plural = (n: number, one: string) => `${n.toLocaleString()} ${n === 1 ? one : `${one}s`}`

/** What joining it brings, in the picker's words. */
const brings = (preview: ChatMergePreview) =>
  preview.continues
    ? `${plural(preview.messages, "new message")} since the last join`
    : `${plural(preview.messages, "message")} since #${preview.from - 1}`

type Reading = { readonly ok: true; readonly preview: ChatMergePreview } | { readonly ok: false; readonly why: string }

function JoinThreadsPicker({ session, forkId, at, chosen, onChoose }: MergeSourcePickerProps) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const sets = useThreadSets(session, view)
  const cast = useCast()
  const name = (id: EntityId) => cast.cards.get(id)?.name ?? null
  const others = sets === null ? [] : otherThreads(sets, forkId)
  const [readings, setReadings] = useState<ReadonlyMap<string, Reading>>(new Map())
  const sourceOf = (other: Offered): MergeSource => ({
    chat: session.id,
    listed: session.id,
    title: threadName(other.thread, name),
    fork: other.forkId
  })
  const wanted = others.map((other) => `${other.key}=${other.forkId}`).join(",")
  useEffect(() => {
    let live = true
    void Promise.all(
      others.map((other) =>
        session
          .call((client) =>
            client("PreviewChatMerge", {
              chatId: session.id,
              forkId,
              at,
              source: { chatId: session.id, forkId: other.forkId },
              includeLeftOut: false
            })
          )
          .then((result): [string, Reading] => [
            other.key,
            result.ok ? { ok: true, preview: result.value } : { ok: false, why: result.error.message }
          ])
      )
    ).then((read) => {
      if (!live) return
      const next = new Map(read)
      setReadings(next)
      // One thread to join: it's ticked already.
      const open = others.filter((other) => next.get(other.key)?.ok === true)
      if (chosen.length === 0 && open.length === 1) onChoose([sourceOf(open[0]!)])
    })
    return () => {
      live = false
    }
    // `wanted` stands for `others`; `at` and `forkId` are the dialog's position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, at, forkId])
  const nested = new Set(others.map((other) => other.set.splitId)).size > 1
  return (
    <div
      role="group"
      aria-label="Threads to join"
      className="flex max-h-72 min-w-0 flex-col gap-3 overflow-y-auto rounded-md border border-border p-3"
    >
      <p className="text-sm font-medium">Threads to join</p>
      {sets !== null && others.length === 0 && (
        <p className="text-sm text-muted">This branch has no other thread to join.</p>
      )}
      {others.map((other, index) => {
        const title = threadName(other.thread, name)
        const reading = readings.get(other.key)
        const on = chosen.some((source) => source.fork === other.forkId)
        const faces = other.thread.cast.flatMap((id) => cast.cards.get(id) ?? [])
        const heading = nested && (index === 0 || others[index - 1]!.set.splitId !== other.set.splitId)
        return (
          <div key={other.key} data-join-thread={other.key} className="flex flex-col gap-1">
            {heading && <p className="text-xs font-medium text-muted">Threads from {splitNumber(other.set)}</p>}
            <div className="flex min-w-0 items-start gap-2">
              <span className="min-w-0 flex-1">
                <Checkbox
                  checked={on}
                  disabled={reading?.ok !== true}
                  onCheckedChange={(next) =>
                    onChoose(
                      next ? [...chosen, sourceOf(other)] : chosen.filter((source) => source.fork !== other.forkId)
                    )
                  }
                  hint={`Joins “${title}” into this thread.`}
                  description={reading === undefined ? "Reading…" : reading.ok ? brings(reading.preview) : reading.why}
                >
                  {title}
                </Checkbox>
              </span>
              {faces.length > 0 && (
                <span
                  aria-label={`In this thread: ${faces.map((face) => face.name).join(", ")}`}
                  className="flex shrink-0 items-center gap-0.5"
                >
                  {faces.slice(0, 3).map((face) => (
                    <Avatar
                      key={face.entityId}
                      id={face.entityId}
                      name={face.name}
                      mediaId={face.avatarMediaId}
                      crop={face.avatarCrop}
                      size="xs"
                    />
                  ))}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** The ⋯ menu's entry: after the newest message. */
export function JoinThreadsCommandDialog({ context, onClose }: ChatCommandDialogProps) {
  return <MergeChatDialog session={context.session} at={null} onClose={onClose} threads={JoinThreadsPicker} />
}

/** A message's action: after this message. */
export function JoinThreadsHereDialog({ session, entry, closeDialog }: MessageActionProps) {
  return <MergeChatDialog session={session} at={entry.slotId} onClose={closeDialog} threads={JoinThreadsPicker} />
}
