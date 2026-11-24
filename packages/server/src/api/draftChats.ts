// RPC handlers for the new-chat page's pending chat (@dreamspan/shared/draftChatApi.ts, DESIGN
// §2.1): a real chat nothing lists until its first turn commits it (db/pendingChats.ts).
import { CurrentUser } from "@dreamspan/shared/api.ts"
import type { Chat, ChatId, EntityId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { DraftChatApi } from "@dreamspan/shared/draftChatApi.ts"
import { startingPersona } from "@dreamspan/shared/personaLock.ts"
import { foldState } from "@dreamspan/shared/state.ts"
import { Effect, Option } from "effect"
import { ChatHub } from "../chat/ChatHub.ts"
import { Reader, Writer } from "../db/Database.ts"
import { drawGreeters } from "./chatSetup.ts"
import { internal } from "./internal.ts"

/**
 * How long a pending chat no tab has open is kept before the next new chat sweeps it: a reload
 * or a deploy drops every socket, and its tab comes back within this (db/pendingChats.ts).
 */
const PENDING_KEPT_MS = 60_000
/** How long after its page left a pending chat is swept, unless another tab still has it. */
export const PENDING_LEFT_MS = 3_000

export const makeDraftChatHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  // A sweep after a leave outlives the request, not the server.
  const scope = yield* Effect.scope
  const userId = Effect.map(CurrentUser, (user) => user.id)
  // A tab subscribed after `held` looked, before the sweep was written, is told the chat is gone,
  // as the bin's deletes tell theirs (SubscribeChat checks the chat once subscribed).
  const sweep = (id: UserId, chatId: ChatId) =>
    Effect.tap(writer.SweepPendingChat({ userId: id, chatId }), (swept) =>
      Effect.sync(() => {
        if (swept) hub.close(chatId, { _tag: "Deleted" })
      })
    )
  // The page's chat, given to its tab: held until the tab subscribes, as if it had just left.
  const given = (chat: Chat) => {
    if (chat.status === "pending") hub.touch(chat.id)
    return chat
  }
  return {
    OpenDraftChat: ({ draftFor, reopen }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const pending = yield* reader.PendingChats({ userId: id })
        // The page's own chat, on a reload: as it is, committed or still pending for this entry.
        if (reopen !== undefined) {
          const own = pending.find((chat) => chat.chatId === reopen)
          if (own?.draftFor === draftFor) return given(yield* reader.GetChat({ userId: id, chatId: reopen }))
          if (own === undefined) {
            const found = yield* reader.GetChat({ userId: id, chatId: reopen }).pipe(Effect.option)
            if (Option.isSome(found) && found.value.status !== "pending") return found.value
          }
        }
        // Pending chats no tab has had open for a while are left behind: each visit draws afresh.
        for (const chat of pending)
          if (chat.chatId !== reopen && !hub.held(chat.chatId, PENDING_KEPT_MS)) yield* sweep(id, chat.chatId)
        const [kind, of] =
          draftFor === "empty"
            ? ["empty", ""]
            : [draftFor.slice(0, draftFor.indexOf(":")), draftFor.slice(draftFor.indexOf(":") + 1)]
        // A new workshop: made as the first send made it before, pending (spec/WORKSHOP-CARDS.md §3).
        if (kind === "workshop") {
          const [card = "", persona = ""] = of.split(":")
          return given(
            yield* writer.CreateWorkshop({
              userId: id,
              draftFor,
              ...(card === "" ? {} : { card }),
              ...(persona === "" ? {} : { persona: persona === "none" ? null : persona })
            })
          )
        }
        // A new chat's own cast, not started yet (New chat with this cast there), has no group:
        // its characters, who the user plays left out.
        const unstarted = kind === "group" ? pending.find((chat) => chat.chatId === of) : undefined
        const group =
          kind === "group" && unstarted === undefined
            ? yield* reader.GroupChats({ userId: id, chatId: of as ChatId })
            : null
        const own =
          unstarted === undefined
            ? null
            : foldState(
                yield* reader.StateEventsAt({
                  userId: id,
                  chatId: of as ChatId,
                  slotId: null,
                  forkId: null,
                  displayEnd: true
                })
              )
        const cards: ReadonlyArray<EntityId> =
          kind === "card"
            ? [of as EntityId]
            : group !== null
              ? group.group.members.map((m) => m.entityId)
              : own !== null
                ? (own.participants.filter(
                    (entity) => !own.playedByMe.includes(entity)
                  ) as unknown as ReadonlyArray<EntityId>)
                : []
        // Who the user plays, once, as the page started it: the persona locked to a single card,
        // else the account default, either only while it is still a live persona (DESIGN §2.2).
        const defaults = yield* reader.GetGenerationDefaults({ userId: id })
        const lock = kind === "card" ? yield* reader.GetPersonaLock({ userId: id, entityId: of as EntityId }) : null
        const candidates = [lock?.entityId, defaults.persona].filter((p): p is EntityId => typeof p === "string")
        const known = candidates.length === 0 ? [] : yield* reader.CastCards({ userId: id, entityIds: candidates })
        const persona = startingPersona({
          single: kind === "card",
          lock: lock?.entityId ?? null,
          defaultPersona: defaults.persona ?? null,
          live: (entity) => known.some((card) => card.entityId === entity && card.persona && !card.inBin)
        })
        const greeters = yield* drawGreeters(
          reader,
          id,
          { cards, persona, greeting: null, frozen: undefined, greeters: undefined },
          (entityId) => reader.GetCardForChat({ userId: id, entityId })
        )
        return given(
          yield* writer.OpenDraftChat({
            userId: id,
            draftFor,
            cards,
            persona,
            greeters,
            title: group?.group.name ?? null
          })
        )
      }).pipe(internal("OpenDraftChat")),

    LeaveDraftChat: ({ chatId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        // Someone else's chat is not found, as anywhere else; a committed one stays as it is.
        yield* reader.GetChat({ userId: id, chatId })
        // The tab's own subscription ends as it goes: whoever still has it then keeps it, and so
        // does a tab it was given to since, which hasn't subscribed yet.
        const leftAt = Date.now()
        yield* Effect.sleep(PENDING_LEFT_MS).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              hub.held(chatId, 0) || hub.touchedAt(chatId) >= leftAt ? Effect.void : sweep(id, chatId)
            )
          ),
          Effect.catchCause((cause) => Effect.logWarning("LeaveDraftChat's sweep failed", cause)),
          (effect) => Effect.forkIn(effect, scope)
        )
      }).pipe(internal("LeaveDraftChat"))
  } satisfies Parameters<typeof DraftChatApi.of>[0]
})
