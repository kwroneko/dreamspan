import { CacheWarmth } from "../chat/CacheWarmth.ts"
import type { RevisionId } from "@rp/shared/library.ts"
// RPC handlers for chat setup, speakers and the send queue (@rp/shared/chatSetupApi.ts).
// Every handler acts as the authenticated user; storage enforces ownership, so another
// user's ids are NotFound. Changes are published to the chat's subscribers.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import type { ChatId, EntityId, SlotId } from "@rp/shared/chat.ts"
import { GenerationUnavailable } from "@rp/shared/chatApi.ts"
import { Cast, type CastChange, ChatNote } from "@rp/shared/chatSetupApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { type ChatState, foldState, noteSwitches, type StateEventData } from "@rp/shared/state.ts"
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
    case "DefaultModel":
      return { key: "model.unbind", value: {} }
    case "DefaultPreset":
      return { key: "preset.unbind", value: {} }
    case "Layout":
      return { key: "layout.cards", value: change.layout }
    case "Roles":
      return { key: "roles.projection", value: change.projection }
    case "Lorebook":
      return { key: change.active ? "lorebook.attach" : "lorebook.detach", value: { ref: change.ref } }
    case "Note":
      return { key: change.active ? "note.activate" : "note.deactivate", value: { note: change.entityId } }
    case "CardLorebook":
      return { key: "lorebook.embedded", value: { entity: change.entityId, on: change.on } }
  }
}

/** The chat's `card.binding`s in a fold, as the database operations take them. */
const bindingsOf = (state: ChatState) =>
  Object.fromEntries(
    Object.entries(state.cardBindings).map(([entity, { ref, revision }]) => [
      entity,
      { ref: ref ?? null, revision: revision ?? null }
    ])
  )

export const makeChatSetupHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const warmth = yield* CacheWarmth
  const hub = yield* ChatHub
  const generations = yield* Generations
  const generator = yield* Generator

  const userId = Effect.map(CurrentUser, (user) => user.id)

  /**
   * The fold of the chat's state after `slotId`, with every card it names, by the name and
   * avatar of the version the chat uses there (its own version's, say).
   */
  const castAt = (user: UserId, chatId: ChatId, slotId: SlotId | null) =>
    Effect.gen(function* () {
      const state = foldState(yield* reader.StateEventsAt({ userId: user, chatId, slotId }))
      const ids = [...new Set([...state.participants, ...state.playedByMe])]
      const cards = yield* reader.CastCards({
        userId: user,
        entityIds: ids as Array<Cast["participants"][number]>,
        chat: { chatId, bindings: bindingsOf(state) }
      })
      return new Cast({
        slotId,
        participants: state.participants as Cast["participants"],
        absent: state.absent as Cast["absent"],
        playedByMe: state.playedByMe as Cast["playedByMe"],
        model: null,
        preset: null,
        lorebooks: state.lorebooks as Cast["lorebooks"],
        cardLorebooksOff: Object.entries(state.embeddedLorebooks).flatMap(([entity, on]) =>
          on ? [] : [entity as Cast["cardLorebooksOff"][number]]
        ),
        layoutCards: state.layoutCards,
        rolesProjection: state.rolesProjection,
        cards
      })
    })

  const handlers = {
    GetShellLibrary: () =>
      Effect.flatMap(userId, (id) => reader.ShellLibrary({ userId: id })).pipe(internal("GetShellLibrary")),
    SetChatPin: (input) =>
      Effect.flatMap(userId, (id) => writer.SetChatPin({ ...input, userId: id })).pipe(internal("SetChatPin")),
    SetHomePinsCollapsed: (input) =>
      Effect.flatMap(userId, (id) => writer.SetHomePinsCollapsed({ ...input, userId: id })).pipe(
        internal("SetHomePinsCollapsed")
      ),
    ListCards: () => Effect.flatMap(userId, (id) => reader.ListCards({ userId: id })).pipe(internal("ListCards")),
    ListCardUsage: () =>
      Effect.flatMap(userId, (id) => reader.CardUsage({ userId: id })).pipe(internal("ListCardUsage")),
    ListChatGroups: () =>
      Effect.flatMap(userId, (id) => reader.ChatGroups({ userId: id })).pipe(internal("ListChatGroups")),
    ListGroupChats: ({ chatId }) =>
      Effect.flatMap(userId, (id) => reader.GroupChats({ userId: id, chatId })).pipe(internal("ListGroupChats")),

    // The group read, then its chats renamed only while still named as read; each open chat hears.
    RenameGroup: ({ chatId, name }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const { chats } = yield* reader.GroupChats({ userId: id, chatId })
        const renamed = yield* writer.RenameChats({
          userId: id,
          chats: chats.map((chat) => ({ chatId: chat.id, from: chat.title })),
          name
        })
        for (const chat of renamed) hub.publish(chat.id, { _tag: "Chat", chat })
        return yield* reader.GroupChats({ userId: id, chatId })
      }).pipe(internal("RenameGroup")),

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
    StartChat: ({ cards, persona, greeting, first, frozen, greeters, title }) =>
      Effect.gen(function* () {
        if (first._tag === "Generate" && Option.isNone(generator)) {
          return yield* new GenerationUnavailable({
            message: "This server has nothing to generate with yet: the context assembler isn't built."
          })
        }
        const id = yield* userId
        // The names the greetings show with: the persona's and each card's, as in the preview.
        const [player] = persona === null ? [] : yield* reader.CastCards({ userId: id, entityIds: [persona] })
        // Who greets: the preview's choices, else every card in the supplied order.
        const asked =
          greeters ??
          cards.map((entityId, index) => ({
            entityId,
            greeting: index === 0 ? (greeting ?? 0) : 0,
            frozen: index === 0 ? frozen : undefined
          }))
        // Every greeting's random and time macros are frozen here, whatever the client sent:
        // the values it saw in the preview are kept, and any it didn't send are drawn now.
        const drawn = yield* Effect.forEach(asked, (greeter) =>
          Effect.map(reader.GetCardForChat({ userId: id, entityId: greeter.entityId }), (card) => {
            const picked =
              greeters === undefined && cards.length > 1 && !(greeter.entityId === cards[0] && greeting !== null)
                ? Math.floor(Math.random() * card.greetings.length)
                : greeter.greeting
            const fields = { description: card.description, personality: card.personality, scenario: card.scenario }
            const names = {
              user: player?.modelName ?? player?.name ?? "User",
              char: card.card.modelName ?? card.card.name
            }
            return {
              entityId: greeter.entityId,
              // A single card's greeting as asked, or a group's preview/random choice.
              greeting: picked,
              frozen: card.greetings.map((text, i) =>
                freezeTemplate(text, fields, names, i === picked ? (greeter.frozen ?? {}) : {})
              )
            }
          })
        )
        const result = yield* writer.StartChat({
          userId: id,
          cards,
          persona,
          greeters: drawn,
          first,
          title: title ?? null
        })
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

    // The cards as the next request reads them after `slotId`: the bindings there decide.
    ListChatCards: ({ chatId, slotId, entityIds }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const state = foldState(yield* reader.StateEventsAt({ userId: id, chatId, slotId }))
        return yield* reader.ChatCards({ userId: id, chatId, entityIds, bindings: bindingsOf(state) })
      }).pipe(internal("ListChatCards")),

    // "Only in this chat": the chat's own version, made on first use from the version the
    // chat uses at `slotId`; if the chat bound another version there, its own is bound instead.
    EditCardForChat: ({ chatId, slotId, entityId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const state = foldState(yield* reader.StateEventsAt({ userId: id, chatId, slotId }))
        const binding = bindingsOf(state)[entityId] ?? null
        const opened = yield* writer.OpenCardOverride({ userId: id, chatId, slotId, entityId, binding })
        if (opened.bound) hub.publish(chatId, { _tag: "State" })
        return opened
      }).pipe(internal("EditCardForChat")),

    ChangeCast: ({ chatId, slotId, change }) =>
      Effect.gen(function* () {
        const id = yield* userId
        if (["Model", "Preset", "DefaultModel", "DefaultPreset"].includes(change._tag)) {
          yield* reader.StateEventsAt({ userId: id, chatId, slotId })
          const selection =
            change._tag === "Model"
              ? { model: { connection: change.connection, model: change.model } }
              : change._tag === "Preset"
                ? { preset: change.ref }
                : change._tag === "DefaultModel"
                  ? { model: null }
                  : { preset: null }
          yield* writer.ChangeGenerationDefaults({ userId: id, change: selection })
          yield* warmth.refreshUser(id)
        } else {
          yield* writer.AddStateEvent({
            userId: id,
            chatId,
            slotId,
            versionId: null,
            scope: null,
            data: toEvent(change)
          })
        }
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
