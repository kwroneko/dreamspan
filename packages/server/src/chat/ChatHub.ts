// Live updates to chats (CLIENT-FRAMEWORK §5): every change to a chat is published here,
// and each subscriber gets the chat's events in batches, one per frame at most.
import type { ChatId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { type Cause, Context, Effect, Layer, Queue, type Scope } from "effect"

type Batch = ReadonlyArray<ChatEvent>

interface Subscriber {
  readonly queue: Queue.Queue<Batch, Cause.Done>
  readonly hello: () => ChatEvent
}

/** About a frame: deltas from every stream of a chat go out together at most this often. */
const BATCH_MS = 16
/** Batches a subscriber may fall behind by, about eight seconds of a busy chat, before it starts over. */
const BACKLOG = 512

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
      out[index!] = { ...previous, text: previous.text + event.text }
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
     * `last`, and their streams end.
     */
    readonly close: (chatId: ChatId, last: ChatEvent) => void
    /**
     * Subscribes for as long as the scope lasts. `hello` is taken at the moment of
     * subscribing, so no event falls between it and the ones that follow.
     */
    readonly subscribe: (
      chatId: ChatId,
      hello: () => ChatEvent
    ) => Effect.Effect<Queue.Dequeue<Batch, Cause.Done>, never, Scope.Scope>
    /**
     * Calls `listener` for each change published to a chat someone subscribes to: every
     * event but streamed text and the cache estimate, which follows from the others.
     */
    readonly listen: (listener: (chatId: ChatId) => void) => Effect.Effect<void, never, Scope.Scope>
  }
>()("rp/chat/ChatHub") {
  static readonly layer = ChatHub.layerWith({ backlog: BACKLOG })

  /** With the backlog a subscriber may fall behind by, in batches: tests make it small. */
  static layerWith(options: { readonly backlog: number }) {
    return Layer.effect(
      ChatHub,
      Effect.gen(function* () {
        const subscribers = new Map<ChatId, Set<Subscriber>>()
        const listeners = new Set<(chatId: ChatId) => void>()
        const pending = new Map<ChatId, Array<ChatEvent>>()
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
            if (!subscribers.has(chatId)) return
            if (
              event._tag !== "Delta" &&
              event._tag !== "Reasoning" &&
              event._tag !== "Section" &&
              event._tag !== "Cache"
            )
              for (const listener of listeners) listener(chatId)
            const events = pending.get(chatId)
            if (events) events.push(event)
            else pending.set(chatId, [event])
            timer ??= setTimeout(flush, BATCH_MS)
          },
          close: (chatId, last) => {
            const batch = coalesce([...(pending.get(chatId) ?? []), last])
            pending.delete(chatId)
            for (const subscriber of subscribers.get(chatId) ?? []) {
              deliver(subscriber, batch, last)
              Queue.endUnsafe(subscriber.queue)
            }
            subscribers.delete(chatId)
          },
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
