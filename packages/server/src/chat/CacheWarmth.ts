// The cache-warmth estimate (DESIGN §5.5), kept current for every chat someone has open: a
// reader worker works it out after the chat changes, and its subscribers get it pushed.
// The client counts the time down itself, so nothing polls.
//
// An estimate assembles the whole next request, as a reply does, so it stays off a reply's
// path: while a reply is being prepared or written in a chat (`hold`), its changes wait,
// and one estimate follows when it ends. A read of the next context (`next`) takes the
// pushed estimate when nothing changed since it was worked out, instead of assembling again.
import type { ChatId, ForkId, SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Context, Effect, FiberSet, Layer, Option, type Scope } from "effect"
import { ImageTokenCounts } from "./ImageTokenCounts.ts"
import { Reader } from "../db/Database.ts"
import { ChatHub } from "./ChatHub.ts"

/** Changes that come together (a send, then its reply starting) make one estimate. */
const SETTLE_MS = 250

/** How long a posted message holds its chat's estimate for the reply its sender asks for next. */
const REPLY_EXPECTED_MS = 5000

/** How long a pushed estimate answers a read of the next context, at most: macros can read the time. */
const REUSE_MS = 60_000

type Estimate = Omit<Effect.Success<ReturnType<Reader["Service"]["CacheWarmth"]>>, "uncounted">
type EstimateError = Effect.Error<ReturnType<Reader["Service"]["CacheWarmth"]>>

interface Watched {
  readonly userId: UserId
  watchers: number
  timer: ReturnType<typeof setTimeout> | undefined
  running: boolean
  /** A change arrived while an estimate ran: estimate again after it. */
  again: boolean
  /** A change arrived while the chat was held: estimate once the hold ends. */
  deferred: boolean
  /** Counts the changes, so an estimate knows whether one came after it started. */
  changes: number
  /** The last estimate, with the change count it saw and when it was worked out. */
  latest: { readonly estimate: Estimate; readonly changes: number; readonly at: number } | undefined
  /** Reads of the next context waiting for the estimate to settle. */
  waiting: Array<() => void>
}

export class CacheWarmth extends Context.Service<
  CacheWarmth,
  {
    /** Keeps the chat's estimate current for as long as the scope lasts. Only for the chat's owner. */
    readonly watch: (userId: UserId, chatId: ChatId) => Effect.Effect<void, never, Scope.Scope>
    /** Estimates the user's open chats again: a card, preset, model or default of theirs changed. */
    readonly refreshAll: Effect.Effect<void>
    readonly refreshUser: (userId: UserId) => Effect.Effect<void>
    /**
     * Holds the chat's estimates while a reply is prepared and written: changes wait, and one
     * estimate follows the last release. Returns the release; calling it again does nothing.
     */
    readonly hold: (chatId: ChatId) => () => void
    /** A message was posted whose sender asks for a reply next: holds briefly, until the reply holds. */
    readonly expectReply: (chatId: ChatId) => void
    /** The next context at a leaf: the pushed estimate when it's current for it, else worked out now. */
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

      const held = (chatId: ChatId) => (holds.get(chatId) ?? 0) > 0 || expected.has(chatId)
      const settled = (entry: Watched, chatId: ChatId) =>
        !entry.running && entry.timer === undefined && !(entry.deferred && held(chatId))
      const wake = (entry: Watched) => {
        for (const resume of entry.waiting.splice(0)) resume()
      }

      const counts = yield* Effect.serviceOption(ImageTokenCounts)
      const estimate = (chatId: ChatId, entry: Watched) => {
        const changes = entry.changes
        return reader.CacheWarmth({ userId: entry.userId, chatId }).pipe(
          Effect.flatMap(({ uncounted, ...next }) =>
            Effect.gen(function* () {
              entry.latest = { estimate: next, changes, at: Date.now() }
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
                start(chatId, entry)
              }
              if (settled(entry, chatId)) wake(entry)
            })
          )
        )
      }

      const start = (chatId: ChatId, entry: Watched) => {
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

      const schedule = (chatId: ChatId) => {
        const entry = watched.get(chatId)
        if (entry === undefined) return
        entry.changes++
        start(chatId, entry)
      }

      // A hold ended: the changes it kept back make one estimate.
      const released = (chatId: ChatId) => {
        if (held(chatId)) return
        const entry = watched.get(chatId)
        if (entry === undefined || !entry.deferred) return
        entry.deferred = false
        start(chatId, entry)
      }

      yield* hub.listen(schedule)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const entry of watched.values()) {
            clearTimeout(entry.timer)
            wake(entry)
          }
          for (const timer of expected.values()) clearTimeout(timer)
        })
      )

      // What the pushed estimate was asked (the active path), or its leaf in its fork.
      const sameLeaf = (estimate: Estimate, leafSlotId: SlotId | null, forkId: ForkId | null) =>
        leafSlotId === null
          ? forkId === null
          : estimate.leafSlotId === leafSlotId && (estimate.forkId ?? null) === forkId

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
                deferred: false,
                changes: 0,
                latest: undefined,
                waiting: []
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
                wake(entry)
              })
          ),
        refreshAll: Effect.sync(() => {
          for (const chatId of watched.keys()) schedule(chatId)
        }),
        refreshUser: (userId) =>
          Effect.sync(() => {
            for (const [chatId, entry] of watched) if (entry.userId === userId) schedule(chatId)
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
            const entry = watched.get(chatId)
            if (entry !== undefined && entry.userId === userId) {
              if (!settled(entry, chatId))
                yield* Effect.callback<void>((resume) => {
                  const done = () => resume(Effect.void)
                  entry.waiting.push(done)
                  return Effect.sync(() => {
                    const at = entry.waiting.indexOf(done)
                    if (at >= 0) entry.waiting.splice(at, 1)
                  })
                })
              const latest = entry.latest
              if (
                latest !== undefined &&
                latest.changes === entry.changes &&
                Date.now() - latest.at < REUSE_MS &&
                sameLeaf(latest.estimate, leafSlotId, forkId)
              )
                return latest.estimate
            }
            const { uncounted: _, ...next } = yield* reader.CacheWarmth({ userId, chatId, leafSlotId, forkId })
            return next
          })
      })
    })
  )
}
