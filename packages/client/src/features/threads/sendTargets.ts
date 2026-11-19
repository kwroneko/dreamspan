// "To 2 threads" (spec/THREADS.md §6): which other threads a tab's composer sends to, and whom the
// user writes as in each, per fork shown. Kept in the tab like a choice in a popover: the ticks
// stay until changed, so a run of messages to both threads needs them once. A send goes to each
// ticked thread's fork the link opens (`openForkId`), with the reply that thread's own Next asks
// for, planned from that thread's cast, tip and composer exactly as its own composer would.
import type { ChatId, EntityId, ForkId } from "@dreamspan/shared/chat.ts"
import type { ThreadInfo, ThreadSet } from "@dreamspan/shared/threads.ts"
import type { SendTarget } from "@dreamspan/shared/threadsApi.ts"
import { useSyncExternalStore } from "react"
import { defaultSpeaker, replyFaces } from "../chat/cast.ts"
import type { PlannedSend } from "../chat/composerControls.tsx"
import { planReply } from "../chat/replyPolicy.ts"
import type { ChatSession, ChatView } from "../chat/session.ts"
import { shownForkOf, threadSetsNow } from "./threadSets.ts"

/** A thread, the same in every fork of its set: `${splitId}:${ordinal}`. */
const threadKey = (set: Pick<ThreadSet, "splitId">, thread: Pick<ThreadInfo, "ordinal">) =>
  `${set.splitId}:${thread.ordinal}`

/** The card to write as there, by thread; null: as that thread's composer writes. */
type Ticks = ReadonlyMap<string, EntityId | null>

const ticks = new Map<string, Ticks>()
const listeners = new Set<() => void>()
export const subscribeTicks = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const changed = () => {
  for (const listener of listeners) listener()
}
const none: Ticks = new Map()
const forkKey = (chatId: ChatId, forkId: ForkId) => `${chatId}/${forkId}`

export const ticksOf = (chatId: ChatId, forkId: ForkId): Ticks => ticks.get(forkKey(chatId, forkId)) ?? none

/** Ticks a thread (with whom to write as there) or unticks it (`writesAs` undefined). */
export const setTick = (chatId: ChatId, forkId: ForkId, key: string, writesAs: EntityId | null | undefined) => {
  const next = new Map(ticksOf(chatId, forkId))
  if (writesAs === undefined) next.delete(key)
  else next.set(key, writesAs)
  ticks.set(forkKey(chatId, forkId), next)
  changed()
}

// The snapshot is the fork's ticks themselves (a new map on each change): a value read beside the
// store, not from it, would be memoized on the arguments alone by the React compiler.
export const useTicks = (chatId: ChatId | null, forkId: ForkId | null): Ticks =>
  useSyncExternalStore(subscribeTicks, () => (chatId === null || forkId === null ? none : ticksOf(chatId, forkId)))

/** For tests: untick everything. */
export const resetTicks = () => {
  ticks.clear()
  changed()
}

/** A thread a send can go to: another thread of a set the fork shown is in, with a live fork. */
export interface Offered {
  readonly key: string
  readonly set: ThreadSet
  readonly thread: ThreadInfo
  readonly forkId: ForkId
}

/** The other threads of the sets the fork shown is in, with a live fork, innermost set first. */
export const otherThreads = (sets: ReadonlyArray<ThreadSet>, shown: ForkId): ReadonlyArray<Offered> => {
  const seen = new Set<ForkId>([shown])
  return sets.flatMap((set) =>
    set.threads.flatMap((thread) => {
      const forkId = thread.openForkId
      if (thread.ordinal === set.self || forkId === null || seen.has(forkId)) return []
      seen.add(forkId)
      return [{ key: threadKey(set, thread), set, thread, forkId }]
    })
  )
}

/** The threads the composer can send to: the other threads, less those joined here with nothing new since. */
export const offeredThreads = (sets: ReadonlyArray<ThreadSet>, shown: ForkId): ReadonlyArray<Offered> =>
  otherThreads(sets, shown).filter((other) => other.thread.joined?.upToDate !== true)

/** The ticked threads a send from this view goes to, with whom to write as in each. */
export const ticked = (view: ChatView) => {
  const shown = shownForkOf(view)
  if (view.chat === null || shown === null) return []
  const chosen = ticksOf(view.chat.id, shown)
  if (chosen.size === 0) return []
  return offeredThreads(threadSetsNow(view.chat.id, shown) ?? [], shown).flatMap((offered) =>
    chosen.has(offered.key) ? [{ ...offered, writesAs: chosen.get(offered.key) ?? null }] : []
  )
}

/**
 * A ticked thread's copy, planned as that thread's composer plans a send: from its cast at its
 * tip, the messages up to its tip, and its composer's speaker and Next (Auto, a pick, No one).
 */
const planThread = async (
  session: ChatSession,
  forkId: ForkId,
  writesAs: EntityId | null,
  send: Pick<PlannedSend, "text" | "images" | "decides">
) => {
  const [window, composer] = await Promise.all([
    session.call((client) =>
      client("ReadPath", { chatId: session.id, forkId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 60 })
    ),
    session.call((client) => client("OpenComposer", { chatId: session.id, forkId }))
  ])
  if (!window.ok) return window
  if (!composer.ok) return composer
  // The cast at that thread's tip: who is away there, as its own composer reads it.
  const tip = window.value.entries.at(-1)?.slotId ?? null
  const cast = await session.call((client) => client("GetCast", { chatId: session.id, forkId, slotId: tip }))
  if (!cast.ok) return cast
  const choice = await session.call((client) =>
    client("GetComposerChoice", { chatId: session.id, draftId: composer.value.id })
  )
  if (!choice.ok) return choice
  const speaker = writesAs ?? choice.value.speakerEntityId ?? defaultSpeaker(cast.value)
  const faces = replyFaces(cast.value, speaker)
  const picked =
    choice.value.replyFromEntityId !== null && faces.includes(choice.value.replyFromEntityId)
      ? choice.value.replyFromEntityId
      : null
  const plan = planReply(
    cast.value,
    window.value.entries,
    speaker,
    picked,
    send.text,
    (send.images?.length ?? 0) > 0,
    choice.value.noReplies
  )
  const target: SendTarget = {
    forkId,
    parentSlotId: window.value.entries.at(-1)?.slotId ?? null,
    speakerEntityId: speaker,
    reply: plan.reply,
    replySpeakerEntityId: plan.replier,
    ...(plan.reply && plan.round.length > 0 ? { round: plan.round } : {}),
    ...(plan.reply && send.decides && plan.auto ? { autoPick: true } : {})
  }
  return { ok: true as const, value: { target, draftId: composer.value.id, picked } }
}

/** Sends to the thread shown and each ticked one, in one write (`SendToThreads`). */
export const sendToThreads = async (send: PlannedSend) => {
  const { session, view } = send
  const others = ticked(view)
  const planned = await Promise.all(others.map((other) => planThread(session, other.forkId, other.writesAs, send)))
  const failed = planned.find((result) => !result.ok)
  if (failed !== undefined && !failed.ok) return { sent: false, outcome: failed, draft: null, recovered: 0 } as const
  const targets = planned.flatMap((result) => (result.ok ? [result.value] : []))
  const own: SendTarget = {
    forkId: send.composer.fork ?? shownForkOf(view)!,
    parentSlotId: view.leafSlotId,
    speakerEntityId: send.speaker,
    reply: send.plan.reply,
    replySpeakerEntityId: send.plan.replier,
    ...(send.plan.reply && send.plan.round.length > 0 ? { round: send.plan.round } : {}),
    ...(send.plan.reply && send.autoPick ? { autoPick: true } : {})
  }
  const result = await session.sendToThreads(
    {
      content: send.text,
      ...(send.images === undefined ? {} : { images: send.images }),
      ...(send.imageDraftIds === undefined ? {} : { imageDraftIds: send.imageDraftIds }),
      targets: [own, ...targets.map((planned) => planned.target)]
    },
    send.composer
  )
  // A face picked there for one reply goes back to the turn order there, as here.
  if (result.sent)
    for (const planned of targets)
      if (planned.picked !== null && planned.target.reply)
        void session.call((client) =>
          client("SetComposerChoice", {
            chatId: session.id,
            draftId: planned.draftId,
            consumeReplyFromEntityId: planned.picked!
          })
        )
  return result
}
