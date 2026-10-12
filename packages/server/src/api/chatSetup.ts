// RPC handlers for chat setup, speakers and the send queue (@rp/shared/chatSetupApi.ts).
// Every handler acts as the authenticated user; storage enforces ownership, so another
// user's ids are NotFound. Changes are published to the chat's subscribers.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { GenerationUnavailable } from "@rp/shared/chatApi.ts"
import { Cast, type CastChange } from "@rp/shared/chatSetupApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { ServerError } from "@rp/shared/errors.ts"
import { foldState, type StateEventData } from "@rp/shared/state.ts"
import { Effect, Option } from "effect"
import { RpcClientError } from "effect/rpc"
import { ChatHub } from "../chat/ChatHub.ts"
import { Generations } from "../chat/Generations.ts"
import { Generator } from "../chat/Generator.ts"
import { Reader, Writer } from "../db/Database.ts"
import { StorageError } from "../db/ops.ts"

type Internal = StorageError | RpcClientError.RpcClientError

/** Storage and worker failures become ServerError, logged; every other error keeps its tag. */
const internal =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Exclude<E, Internal> | ServerError, R> =>
    Effect.catchIf(
      effect,
      (error): error is Extract<E, Internal> =>
        error instanceof StorageError || error instanceof RpcClientError.RpcClientError,
      (error) =>
        Effect.logError(`${operation} failed`, error).pipe(
          Effect.andThen(Effect.fail(new ServerError({ message: `${operation} failed` })))
        )
    ) as Effect.Effect<A, Exclude<E, Internal> | ServerError, R>

/** A cast change as the state event it records (DATA-MODEL §5.3), chat-wide. */
const toEvent = (change: CastChange): StateEventData => {
  switch (change._tag) {
    case "Join":
      return { key: "participant.join", value: { entity: change.entityId } }
    case "Leave":
      return { key: "participant.leave", value: { entity: change.entityId } }
    case "Presence":
      return { key: "presence.set", value: { entity: change.entityId, present: change.present } }
    case "PlayedByMe":
      return { key: "played_by_me.set", value: { entities: change.entityIds } }
    case "Model":
      return { key: "model.binding", value: { connection: change.connection, model: change.model } }
    case "Preset":
      return { key: "preset.binding", value: { ref: change.ref } }
    case "Layout":
      return { key: "layout.cards", value: change.layout }
    case "Roles":
      return { key: "roles.projection", value: change.projection }
  }
}

export const makeChatSetupHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  const generations = yield* Generations
  const generator = yield* Generator

  const userId = Effect.map(CurrentUser, (user) => user.id)

  /** The fold of the chat's state after `slotId`, with every card it names. */
  const castAt = (user: UserId, chatId: ChatId, slotId: SlotId | null) =>
    Effect.gen(function* () {
      const state = foldState(yield* reader.StateEventsAt({ userId: user, chatId, slotId }))
      const ids = [...new Set([...state.participants, ...state.playedByMe])]
      const cards = yield* reader.CastCards({ userId: user, entityIds: ids as Array<Cast["participants"][number]> })
      const model = state.modelBindings[""]
      return new Cast({
        slotId,
        participants: state.participants as Cast["participants"],
        absent: state.absent as Cast["absent"],
        playedByMe: state.playedByMe as Cast["playedByMe"],
        model: model ? (model as NonNullable<Cast["model"]>) : null,
        preset: (state.presetBindings[""]?.ref ?? null) as Cast["preset"],
        layoutCards: state.layoutCards,
        rolesProjection: state.rolesProjection,
        cards
      })
    })

  const handlers = {
    ListCards: () => Effect.flatMap(userId, (id) => reader.ListCards({ userId: id })).pipe(internal("ListCards")),

    SetPersona: ({ entityId, persona }) =>
      Effect.gen(function* () {
        const id = yield* userId
        yield* writer.SetPersona({ userId: id, entityId, persona })
        const [card] = yield* reader.CastCards({ userId: id, entityIds: [entityId] })
        return card!
      }).pipe(internal("SetPersona")),

    GetCardForChat: ({ entityId }) =>
      Effect.flatMap(userId, (id) => reader.GetCardForChat({ userId: id, entityId })).pipe(internal("GetCardForChat")),

    // Once the chat is written, a first reply starts even if the caller has gone.
    StartChat: ({ cards, persona, greeting, first }) =>
      Effect.gen(function* () {
        if (first._tag === "Generate" && Option.isNone(generator)) {
          return yield* new GenerationUnavailable({
            message: "This server has nothing to generate with yet: the context assembler isn't built."
          })
        }
        const id = yield* userId
        const result = yield* writer.StartChat({ userId: id, cards, persona, greeting, first })
        if (first._tag === "Generate") {
          yield* generations.start({
            userId: id,
            chatId: result.chat.id,
            slotId: result.slotId,
            versionId: result.version.id
          })
        }
        const { entry } = yield* reader.GetSlot({ userId: id, slotId: result.slotId })
        return { entry, chat: result.chat }
      }).pipe(Effect.uninterruptible, internal("StartChat")),

    GetCast: ({ chatId, slotId }) =>
      Effect.flatMap(userId, (id) => castAt(id, chatId, slotId)).pipe(internal("GetCast")),

    ChangeCast: ({ chatId, slotId, change }) =>
      Effect.gen(function* () {
        const id = yield* userId
        yield* writer.AddStateEvent({ userId: id, chatId, slotId, versionId: null, scope: null, data: toEvent(change) })
        hub.publish(chatId, { _tag: "State" })
        return yield* castAt(id, chatId, slotId)
      }).pipe(internal("ChangeCast")),

    ListQueued: ({ chatId }) =>
      Effect.flatMap(userId, (id) => reader.ListQueued({ userId: id, chatId })).pipe(internal("ListQueued")),

    EditQueued: ({ queuedId, content, speakerEntityId, expectedRowVersion }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const { queued, queue } = yield* writer.EditQueued({
          userId: id,
          queuedId,
          content,
          speakerEntityId,
          expectedRowVersion
        })
        hub.publish(queued.chatId, { _tag: "Queue", queue })
        return queued
      }).pipe(internal("EditQueued")),

    WithdrawQueued: ({ queuedId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const { queued, queue } = yield* writer.WithdrawQueued({ userId: id, queuedId })
        hub.publish(queued.chatId, { _tag: "Queue", queue })
        return queued
      }).pipe(internal("WithdrawQueued"))
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
  return handlers
})
