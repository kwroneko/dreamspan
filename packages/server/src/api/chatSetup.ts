import type { RevisionId } from "@rp/shared/library.ts"
// RPC handlers for chat setup, speakers and the send queue (@rp/shared/chatSetupApi.ts).
// Every handler acts as the authenticated user; storage enforces ownership, so another
// user's ids are NotFound. Changes are published to the chat's subscribers.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import type { ChatId, EntityId, SlotId } from "@rp/shared/chat.ts"
import { GenerationUnavailable } from "@rp/shared/chatApi.ts"
import { Cast, type CastChange, ChatNote } from "@rp/shared/chatSetupApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { foldState, noteSwitches, type StateEventData } from "@rp/shared/state.ts"
import { Effect, Option } from "effect"
import { ChatHub } from "../chat/ChatHub.ts"
import { Generations } from "../chat/Generations.ts"
import { Generator } from "../chat/Generator.ts"
import { Reader, Writer } from "../db/Database.ts"
import { freezeTemplate } from "../chat/macros.ts"
import { internal } from "./internal.ts"

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
    case "Lorebook":
      return { key: change.active ? "lorebook.attach" : "lorebook.detach", value: { ref: change.ref } }
    case "Note":
      return { key: change.active ? "note.activate" : "note.deactivate", value: { note: change.entityId } }
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
        lorebooks: state.lorebooks as Cast["lorebooks"],
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
    StartChat: ({ cards, persona, greeting, first, frozen }) =>
      Effect.gen(function* () {
        if (first._tag === "Generate" && Option.isNone(generator)) {
          return yield* new GenerationUnavailable({
            message: "This server has nothing to generate with yet: the context assembler isn't built."
          })
        }
        const id = yield* userId
        // Every greeting's random and time macros are frozen here, whatever the client sent:
        // the values it saw in the preview are kept, and any it didn't send are drawn now.
        const lead = yield* reader.GetCardForChat({ userId: id, entityId: cards[0]! })
        const fields = { description: lead.description, personality: lead.personality, scenario: lead.scenario }
        // The names the greeting shows with: the persona's and the card's, as in the preview.
        const [player] = persona === null ? [] : yield* reader.CastCards({ userId: id, entityIds: [persona] })
        const names = { user: player?.name ?? "User", char: lead.card.name }
        const picked = greeting ?? 0
        const drawn = lead.greetings.map((text, i) =>
          freezeTemplate(text, fields, names, i === picked ? (frozen ?? {}) : {})
        )
        const result = yield* writer.StartChat({ userId: id, cards, persona, greeting, first, frozen: drawn })
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

    // The notes the context assembler reads at this position: the chat's own and its characters'.
    ListChatNotes: ({ chatId, slotId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const events = yield* reader.StateEventsAt({ userId: id, chatId, slotId })
        const state = foldState(events)
        const played = new Set(state.playedByMe)
        const cards = state.participants.filter((entity) => !played.has(entity)) as Array<EntityId>
        const switches = noteSwitches(events)
        const entries = yield* reader.ChatNoteEntries({ userId: id, chatId, slotId, cards })
        return yield* Effect.forEach(entries, (entry) =>
          Effect.gen(function* () {
            const revisionId = state.noteRevisions[entry.ref.entityId] as RevisionId | undefined
            const resolved =
              entry.card !== null && revisionId
                ? {
                    ref: { ...entry.ref, headRevisionId: revisionId },
                    doc: yield* reader.GetRevisionDoc({ userId: id, refId: entry.ref.id, revisionId })
                  }
                : entry
            return new ChatNote({ ...entry, ...resolved, active: switches.get(entry.ref.entityId) ?? entry.first })
          })
        )
      }).pipe(internal("ListChatNotes")),

    CreateChatNote: ({ chatId, title }) =>
      Effect.flatMap(userId, (id) => writer.CreateChatNote({ userId: id, chatId, title })).pipe(
        internal("CreateChatNote")
      ),

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

    WithdrawQueued: ({ queuedId, expectedRowVersion }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const { queued, queue } = yield* writer.WithdrawQueued({ userId: id, queuedId, expectedRowVersion })
        hub.publish(queued.chatId, { _tag: "Queue", queue })
        return queued
      }).pipe(internal("WithdrawQueued"))
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
  return handlers
})
