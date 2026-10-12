// Live updates to chats (CLIENT-FRAMEWORK §5): every change to a chat is published here,
// and each subscriber gets the chat's events in batches, one per frame at most.
import type { ChatId, VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { type Cause, Context, Effect, Layer, Queue, type Scope } from "effect"

type Batch = ReadonlyArray<ChatEvent>
type Subscriber = Queue.Queue<Batch, Cause.Done>

/** About a frame: deltas from every stream of a chat go out together at most this often. */
const BATCH_MS = 16

/**
 * Merges consecutive deltas of a version into one. Any other event is a barrier, so
 * every event keeps its place relative to the version's text.
 */
const coalesce = (events: ReadonlyArray<ChatEvent>): Array<ChatEvent> => {
  const out: Array<ChatEvent> = []
  const lastDelta = new Map<VersionId, number>()
  for (const event of events) {
    if (event._tag !== "Delta") {
      lastDelta.clear()
      out.push(event)
      continue
    }
    const index = lastDelta.get(event.versionId)
    const previous = index === undefined ? undefined : out[index]
    if (previous?._tag === "Delta" && previous.offset + previous.text.length === event.offset) {
      out[index!] = { ...previous, text: previous.text + event.text }
    } else {
      lastDelta.set(event.versionId, out.length)
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
  }
>()("rp/chat/ChatHub") {
  static readonly layer = Layer.effect(
    ChatHub,
    Effect.gen(function* () {
      const subscribers = new Map<ChatId, Set<Subscriber>>()
      const pending = new Map<ChatId, Array<ChatEvent>>()
      let timer: ReturnType<typeof setTimeout> | undefined

      const flush = () => {
        timer = undefined
        for (const [chatId, events] of pending) {
          const batch = coalesce(events)
          for (const queue of subscribers.get(chatId) ?? []) Queue.offerUnsafe(queue, batch)
        }
        pending.clear()
      }
      yield* Effect.addFinalizer(() => Effect.sync(() => clearTimeout(timer)))

      return ChatHub.of({
        publish: (chatId, event) => {
          if (!subscribers.has(chatId)) return
          const events = pending.get(chatId)
          if (events) events.push(event)
          else pending.set(chatId, [event])
          timer ??= setTimeout(flush, BATCH_MS)
        },
        close: (chatId, last) => {
          const batch = coalesce([...(pending.get(chatId) ?? []), last])
          pending.delete(chatId)
          for (const queue of subscribers.get(chatId) ?? []) {
            Queue.offerUnsafe(queue, batch)
            Queue.endUnsafe(queue)
          }
          subscribers.delete(chatId)
        },
        subscribe: (chatId, hello) =>
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<Batch, Cause.Done>()
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const set = subscribers.get(chatId) ?? new Set()
                subscribers.set(chatId, set)
                set.add(queue)
                Queue.offerUnsafe(queue, [hello()])
              }),
              () =>
                Effect.sync(() => {
                  const set = subscribers.get(chatId)
                  set?.delete(queue)
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
