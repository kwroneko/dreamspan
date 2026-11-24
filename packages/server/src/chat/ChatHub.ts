// Live updates to chats (CLIENT-FRAMEWORK §5): every change to a chat is published here,
// and each subscriber gets the chat's events in batches, one per frame at most.
import type { ChatId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { type Cause, Context, Effect, Layer, Queue, type Scope } from "effect"

type Batch = ReadonlyArray<ChatEvent>
type Listener = (chatId: ChatId, event?: ChatEvent, owner?: UserId) => void

interface Subscriber {
  readonly queue: Queue.Queue<Batch, Cause.Done>
  readonly hello: () => ChatEvent
}

/** About a frame: deltas from every stream of a chat go out together at most this often. */
const BATCH_MS = 16
/** Batches a subscriber may fall behind by, about eight seconds of a busy chat, before it starts over. */
const BACKLOG = 512
/** The longest grace `held` is asked for: when each chat was last left is forgotten after this. */
const HELD_MAX_MS = 10 * 60_000

/**
 * Queues a batch for a subscriber. One that has fallen a whole backlog behind (a stalled
 * socket, a throttled tab) starts over instead of holding ever more memory: what it
 * hasn't taken is dropped, and a fresh Hello, with the text so far of every generation,
 * makes its client read everything again. `instead` replaces that Hello (a final event).
 */
const deliver = (subscriber: Subscriber, batch: Batch, instead?: ChatEvent) => {
  if (Queue.offerUnsafe(subscriber.queue, batch)) return
  while (Queue.sizeUnsafe(subscriber.queue) > 0) Queue.takeUnsafe(subscriber.queue)
  Queue.offerUnsafe(subscriber.queue, [instead ?? subscriber.hello()])
}

/**
 * Merges consecutive deltas of a version into one, its text, reasoning and sections apart. Any
 * other event is a barrier, so every event keeps its place relative to the version's text.
 */
const coalesce = (events: ReadonlyArray<ChatEvent>): Array<ChatEvent> => {
  const out: Array<ChatEvent> = []
  // By kind and version: a version's text and reasoning streams merge apart.
  const lastDelta = new Map<string, number>()
  for (const event of events) {
    if (event._tag !== "Delta" && event._tag !== "Reasoning" && event._tag !== "Section") {
      lastDelta.clear()
      out.push(event)
      continue
    }
    const key = `${event._tag}:${event.versionId}`
    const index = lastDelta.get(key)
    const previous = index === undefined ? undefined : out[index]
    if (previous?._tag === event._tag && previous.offset + previous.text.length === event.offset) {
      out[index!] = {
        ...previous,
        text: previous.text + event.text,
        ...(event.sequence === undefined ? {} : { sequence: event.sequence })
      }
    } else {
      lastDelta.set(key, out.length)
      out.push(event)
    }
  }
  return out
}

export class ChatHub extends Context.Service<
  ChatHub,
  {
    /** Queues an event for the chat's subscribers. Never blocks: it's called for every streamed token. */
    readonly publish: (chatId: ChatId, event: ChatEvent) => void
    /**
     * Ends every subscription to a chat that's gone: what's pending goes out at once, then
     * `last`, and their streams end. Pass the owner if the chat could have appeared in the shell.
     */
    readonly close: (chatId: ChatId, last: ChatEvent, owner?: UserId) => void
    /**
     * Subscribes for as long as the scope lasts. `hello` is taken at the moment of
     * subscribing, so no event falls between it and the ones that follow.
     */
    readonly subscribe: (
      chatId: ChatId,
      hello: () => ChatEvent
    ) => Effect.Effect<Queue.Dequeue<Batch, Cause.Done>, never, Scope.Scope>
    /**
     * Calls `listener` for each change published to a chat: every
     * event but streamed text and the cache estimate, which follows from the others.
     */
    readonly listen: (listener: Listener) => Effect.Effect<void, never, Scope.Scope>
    /**
     * Whether a tab may still have the chat open: someone is subscribed, or the last one left
     * (or it was given out, `touch`) less than `graceMs` ago, at most HELD_MAX_MS (or the server
     * started less than that ago, as after a deploy, while tabs reconnect). A pending chat is
     * swept only when nobody has it (db/pendingChats.ts).
     */
    readonly held: (chatId: ChatId, graceMs: number) => boolean
    /** The chat was just given to a tab that hasn't subscribed yet: `held` counts it as just left. */
    readonly touch: (chatId: ChatId) => void
    /** When the chat was last given out (`touch`), 0 if not lately: a leave keeps a chat given out since. */
    readonly touchedAt: (chatId: ChatId) => number
  }
>()("rp/chat/ChatHub") {
  static readonly layer = ChatHub.layerWith({ backlog: BACKLOG })

  /** With the backlog a subscriber may fall behind by, in batches: tests make it small. */
  static layerWith(options: { readonly backlog: number }) {
    return Layer.effect(
      ChatHub,
      Effect.gen(function* () {
        const subscribers = new Map<ChatId, Set<Subscriber>>()
        const listeners = new Set<Listener>()
        const pending = new Map<ChatId, Array<ChatEvent>>()
        // When each chat's last subscriber left, for `held`, oldest first: kept HELD_MAX_MS, then
        // forgotten, so a long-running server holds only the chats left lately.
        const left = new Map<ChatId, number>()
        const startedAt = Date.now()
        // When each chat was last given out, kept as `left` is.
        const touched = new Map<ChatId, number>()
        const leave = (chatId: ChatId) => {
          const now = Date.now()
          left.delete(chatId)
          left.set(chatId, now)
          for (const [id, at] of left) {
            if (now - at < HELD_MAX_MS) break
            left.delete(id)
          }
        }
        let timer: ReturnType<typeof setTimeout> | undefined

        const flush = () => {
          timer = undefined
          for (const [chatId, events] of pending) {
            const batch = coalesce(events)
            for (const subscriber of subscribers.get(chatId) ?? []) deliver(subscriber, batch)
          }
          pending.clear()
        }
        yield* Effect.addFinalizer(() => Effect.sync(() => clearTimeout(timer)))

        return ChatHub.of({
          publish: (chatId, event) => {
            if (
              event._tag !== "Delta" &&
              event._tag !== "Reasoning" &&
              event._tag !== "Section" &&
              event._tag !== "Cache"
            )
              for (const listener of listeners) listener(chatId, event)
            if (!subscribers.has(chatId)) return
            const events = pending.get(chatId)
            if (events) events.push(event)
            else pending.set(chatId, [event])
            timer ??= setTimeout(flush, BATCH_MS)
          },
          close: (chatId, last, owner) => {
            for (const listener of listeners) listener(chatId, undefined, owner)
            const batch = coalesce([...(pending.get(chatId) ?? []), last])
            pending.delete(chatId)
            for (const subscriber of subscribers.get(chatId) ?? []) {
              deliver(subscriber, batch, last)
              Queue.endUnsafe(subscriber.queue)
            }
            subscribers.delete(chatId)
          },
          held: (chatId, graceMs) =>
            (subscribers.get(chatId)?.size ?? 0) > 0 ||
            Date.now() - Math.max(startedAt, left.get(chatId) ?? 0) < Math.min(graceMs, HELD_MAX_MS),
          touch: (chatId) => {
            const now = Date.now()
            touched.delete(chatId)
            touched.set(chatId, now)
            for (const [id, at] of touched) {
              if (now - at < HELD_MAX_MS) break
              touched.delete(id)
            }
            if ((subscribers.get(chatId)?.size ?? 0) === 0) leave(chatId)
          },
          touchedAt: (chatId) => touched.get(chatId) ?? 0,
          listen: (listener) =>
            Effect.acquireRelease(
              Effect.sync(() => listeners.add(listener)),
              () => Effect.sync(() => listeners.delete(listener))
            ),
          subscribe: (chatId, hello) =>
            Effect.gen(function* () {
              const queue = yield* Queue.bounded<Batch, Cause.Done>(options.backlog)
              const subscriber: Subscriber = { queue, hello }
              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  const set = subscribers.get(chatId) ?? new Set()
                  subscribers.set(chatId, set)
                  set.add(subscriber)
                  Queue.offerUnsafe(queue, [hello()])
                }),
                () =>
                  Effect.sync(() => {
                    const set = subscribers.get(chatId)
                    set?.delete(subscriber)
                    if (set?.size === 0) {
                      subscribers.delete(chatId)
                      pending.delete(chatId)
                      leave(chatId)
                    }
                  })
              )
              return queue
            })
        })
      })
    )
  }
}
