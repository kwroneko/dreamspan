// The cache-warmth estimate (DESIGN §5.5), kept current for every chat someone has open: a
// reader worker works it out after the chat changes, and its subscribers get it pushed.
// The client counts the time down itself, so nothing polls.
//
// An estimate assembles the whole next request, as a reply does, so it stays off a reply's
// path: while a reply is being prepared or written in a chat (`hold`), its changes wait,
// and one estimate follows when it ends. A read of the next context (`next`) waits the same
// way, then is worked out from what's stored then.
import type { ChatId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Context, Effect, FiberSet, Layer, Option, type Scope } from "effect"
import { ImageTokenCounts } from "./ImageTokenCounts.ts"
import { Reader } from "../db/Database.ts"
import { ChatHub } from "./ChatHub.ts"

/** Changes that come together (a send, then its reply starting) make one estimate. */
const SETTLE_MS = 250

/**
 * How long a posted message holds its chat's estimate for the reply its sender asks for next.
 * The client asks within a round trip; an API caller that never does delays reads this long.
 */
const REPLY_EXPECTED_MS = 2000

type Estimate = Omit<Effect.Success<ReturnType<Reader["Service"]["CacheWarmth"]>>, "uncounted">
type EstimateError =
  | Effect.Error<ReturnType<Reader["Service"]["CacheWarmth"]>>
  | Effect.Error<ReturnType<Reader["Service"]["NextContextAccess"]>>

interface Watched {
  readonly userId: UserId
  watchers: number
  timer: ReturnType<typeof setTimeout> | undefined
  running: boolean
  /** A change arrived while an estimate ran: estimate again after it. */
  again: boolean
  /** A change arrived while the chat was held: estimate once the hold ends. */
  deferred: boolean
}

export class CacheWarmth extends Context.Service<
  CacheWarmth,
  {
    /** Keeps the chat's estimate current for as long as the scope lasts. Only for the chat's owner. */
    readonly watch: (userId: UserId, chatId: ChatId) => Effect.Effect<void, never, Scope.Scope>
    /** Estimates the user's open chats again: a card, preset, model or default of theirs changed. */
    readonly refreshAll: Effect.Effect<void>
    readonly refreshUser: (userId: UserId, configurationChanged?: boolean) => Effect.Effect<void>
    /**
     * Holds the chat's estimates while a reply is prepared and written: changes wait, and one
     * estimate follows the last release. Returns the release; calling it again does nothing.
     */
    readonly hold: (chatId: ChatId) => () => void
    /** A message was posted whose sender asks for a reply next: holds briefly, until the reply holds. */
    readonly expectReply: (chatId: ChatId) => void
    /** The next context at a leaf, worked out once nothing holds the chat. */
    readonly next: (
      userId: UserId,
      chatId: ChatId,
      leafSlotId: SlotId | null,
      forkId: ForkId | null
    ) => Effect.Effect<Estimate, EstimateError>
  }
>()("rp/chat/CacheWarmth") {
  static readonly layer = Layer.effect(
    CacheWarmth,
    Effect.gen(function* () {
      const reader = yield* Reader
      const hub = yield* ChatHub
      const run = yield* FiberSet.runtime(yield* FiberSet.make())()
      const watched = new Map<ChatId, Watched>()
      const holds = new Map<ChatId, number>()
      const expected = new Map<ChatId, ReturnType<typeof setTimeout>>()
      /** Reads of the next context waiting for a chat's holds to end. */
      const waiting = new Map<ChatId, Array<() => void>>()

      const held = (chatId: ChatId) => (holds.get(chatId) ?? 0) > 0 || expected.has(chatId)

      const counts = yield* Effect.serviceOption(ImageTokenCounts)
      const estimate = (chatId: ChatId, entry: Watched) =>
        reader.CacheWarmth({ userId: entry.userId, chatId }).pipe(
          Effect.flatMap(({ uncounted, ...next }) =>
            Effect.gen(function* () {
              hub.publish(chatId, { _tag: "Cache", ...next })
              // Images the model hasn't counted: counted in the background, then estimated again.
              if (uncounted && Option.isSome(counts))
                yield* counts.value.request(entry.userId, uncounted, () => {
                  for (const [id, watchedEntry] of watched) if (watchedEntry.userId === entry.userId) schedule(id)
                })
            })
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catch((error) => Effect.logWarning(`estimating the cache of chat ${chatId} failed`, error)),
          Effect.ensuring(
            Effect.sync(() => {
              entry.running = false
              if (entry.again) {
                entry.again = false
                schedule(chatId)
              }
            })
          )
        )

      const schedule = (chatId: ChatId) => {
        const entry = watched.get(chatId)
        if (entry === undefined) return
        if (held(chatId)) {
          entry.deferred = true
          return
        }
        if (entry.running) {
          entry.again = true
          return
        }
        clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          entry.timer = undefined
          if (watched.get(chatId) !== entry) return
          if (held(chatId)) {
            entry.deferred = true
            return
          }
          entry.running = true
          run(estimate(chatId, entry))
        }, SETTLE_MS)
      }

      // A hold ended: reads waiting go on, and the changes it kept back make one estimate.
      const released = (chatId: ChatId) => {
        if (held(chatId)) return
        for (const resume of waiting.get(chatId) ?? []) resume()
        waiting.delete(chatId)
        const entry = watched.get(chatId)
        if (entry === undefined || !entry.deferred) return
        entry.deferred = false
        schedule(chatId)
      }

      yield* hub.listen((chatId, event) => {
        // A tab-local correction refreshes its own next context. A chat-wide estimate would
        // tell unrelated tabs to read again even though their cached requests did not change.
        if (event && ["State", "Reload", "Lcm"].includes(event._tag) && "forkId" in event && event.forkId !== undefined)
          return
        schedule(chatId)
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const entry of watched.values()) clearTimeout(entry.timer)
          for (const timer of expected.values()) clearTimeout(timer)
          for (const resumes of waiting.values()) for (const resume of resumes) resume()
        })
      )

      return CacheWarmth.of({
        watch: (userId, chatId) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const entry = watched.get(chatId) ?? {
                userId,
                watchers: 0,
                timer: undefined,
                running: false,
                again: false,
                deferred: false
              }
              entry.watchers++
              watched.set(chatId, entry)
              // A new subscriber needs the estimate as it is now.
              schedule(chatId)
            }),
            () =>
              Effect.sync(() => {
                const entry = watched.get(chatId)
                if (entry === undefined || --entry.watchers > 0) return
                clearTimeout(entry.timer)
                watched.delete(chatId)
              })
          ),
        refreshAll: Effect.sync(() => {
          for (const chatId of watched.keys()) schedule(chatId)
        }),
        refreshUser: (userId, configurationChanged = false) =>
          Effect.sync(() => {
            for (const [chatId, entry] of watched) {
              if (entry.userId !== userId) continue
              // Global choices must be announced even while estimates are held by a reply.
              if (configurationChanged) hub.publish(chatId, { _tag: "State" })
              schedule(chatId)
            }
          }),
        hold: (chatId) => {
          holds.set(chatId, (holds.get(chatId) ?? 0) + 1)
          // The reply it was expecting holds now.
          clearTimeout(expected.get(chatId))
          expected.delete(chatId)
          let done = false
          return () => {
            if (done) return
            done = true
            const left = (holds.get(chatId) ?? 1) - 1
            if (left > 0) holds.set(chatId, left)
            else holds.delete(chatId)
            released(chatId)
          }
        },
        expectReply: (chatId) => {
          if ((holds.get(chatId) ?? 0) > 0) return
          clearTimeout(expected.get(chatId))
          expected.set(
            chatId,
            setTimeout(() => {
              expected.delete(chatId)
              released(chatId)
            }, REPLY_EXPECTED_MS)
          )
        },
        next: (userId, chatId, leafSlotId, forkId) =>
          Effect.gen(function* () {
            // Refusals come at once: another user's chat, or a leaf or fork from one, never
            // waits on (or shows the timing of) that chat's reply.
            if (held(chatId)) yield* reader.NextContextAccess({ userId, chatId, leafSlotId, forkId })
            if (held(chatId))
              yield* Effect.callback<void>((resume) => {
                const done = () => resume(Effect.void)
                waiting.set(chatId, [...(waiting.get(chatId) ?? []), done])
                return Effect.sync(() => {
                  const left = (waiting.get(chatId) ?? []).filter((other) => other !== done)
                  if (left.length > 0) waiting.set(chatId, left)
                  else waiting.delete(chatId)
                })
              })
            // What to count is the server's own business (ImageTokenCounts).
            const { uncounted: _, ...next } = yield* reader.CacheWarmth({ userId, chatId, leafSlotId, forkId })
            return next
          })
      })
    })
  )
}
