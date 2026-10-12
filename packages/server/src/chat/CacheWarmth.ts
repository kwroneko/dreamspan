// The cache-warmth estimate (DESIGN §5.5), kept current for every chat someone has open: a
// reader worker works it out after the chat changes, and its subscribers get it pushed.
// The client counts the time down itself, so nothing polls.
import type { ChatId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Context, Effect, FiberSet, Layer, type Scope } from "effect"
import { Reader } from "../db/Database.ts"
import { ChatHub } from "./ChatHub.ts"

/** Changes that come together (a send, then its reply starting) make one estimate. */
const SETTLE_MS = 250

interface Watched {
  readonly userId: UserId
  watchers: number
  timer: ReturnType<typeof setTimeout> | undefined
  running: boolean
  /** A change arrived while an estimate ran: estimate again after it. */
  again: boolean
}

export class CacheWarmth extends Context.Service<
  CacheWarmth,
  {
    /** Keeps the chat's estimate current for as long as the scope lasts. Only for the chat's owner. */
    readonly watch: (userId: UserId, chatId: ChatId) => Effect.Effect<void, never, Scope.Scope>
    /** Estimates the user's open chats again: a card, preset, model or default of theirs changed. */
    readonly refreshUser: (userId: UserId) => Effect.Effect<void>
  }
>()("rp/chat/CacheWarmth") {
  static readonly layer = Layer.effect(
    CacheWarmth,
    Effect.gen(function* () {
      const reader = yield* Reader
      const hub = yield* ChatHub
      const run = yield* FiberSet.runtime(yield* FiberSet.make())()
      const watched = new Map<ChatId, Watched>()

      const estimate = (chatId: ChatId, entry: Watched) =>
        reader.CacheWarmth({ userId: entry.userId, chatId }).pipe(
          Effect.map((warmth) => hub.publish(chatId, { _tag: "Cache", warmth })),
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
        if (entry.running) {
          entry.again = true
          return
        }
        clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          entry.timer = undefined
          if (watched.get(chatId) !== entry) return
          entry.running = true
          run(estimate(chatId, entry))
        }, SETTLE_MS)
      }

      yield* hub.listen(schedule)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const entry of watched.values()) clearTimeout(entry.timer)
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
                again: false
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
        refreshUser: (userId) =>
          Effect.sync(() => {
            for (const [chatId, entry] of watched) if (entry.userId === userId) schedule(chatId)
          })
      })
    })
  )
}
