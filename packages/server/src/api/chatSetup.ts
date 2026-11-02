import { offeredGreetings, greetingPick } from "@rp/shared/greetings.ts"
import { EditRefused } from "@rp/shared/editorApi.ts"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import type { RevisionId } from "@rp/shared/library.ts"
// RPC handlers for chat setup, speakers and the send queue (@rp/shared/chatSetupApi.ts).
// Every handler acts as the authenticated user; storage enforces ownership, so another
// user's ids are NotFound. Changes are published to the chat's subscribers.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import type { CastCard, ChatId, EntityId, ForkId, SlotId } from "@rp/shared/chat.ts"
import { GenerationUnavailable } from "@rp/shared/chatApi.ts"
import { Cast, type CastChange, ChatNote, ShellCards, ShellForks, ShellLibrary } from "@rp/shared/chatSetupApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { type ChatState, foldState, noteSwitches, type StateEventData } from "@rp/shared/state.ts"
import { Effect, Option } from "effect"
import { ChatHub } from "../chat/ChatHub.ts"
import { Generations } from "../chat/Generations.ts"
import { Generator } from "../chat/Generator.ts"
import { Reader, Writer } from "../db/Database.ts"
import type { ChatSummaries } from "../db/forkSummaries.ts"
import { freezeTemplate } from "../chat/macros.ts"
import { internal } from "./internal.ts"

/** A cast change as the state event it records (DATA-MODEL §5.3), chat-wide. */
const toEvent = (change: Exclude<CastChange, { readonly _tag: "Persona" }>): StateEventData => {
  switch (change._tag) {
    case "Swap":
      return { key: "card.swap", value: { entity: change.entityId, replaces: change.replaces } }
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
    case "MacroBinding":
      return change.value === null
        ? { key: "macro.unbind", value: { name: change.name } }
        : { key: "macro.binding", value: { name: change.name, value: change.value } }
    case "Roles":
      return { key: "roles.projection", value: change.projection }
    case "Lorebook":
      return { key: change.active ? "lorebook.attach" : "lorebook.detach", value: { ref: change.ref } }
    case "Note":
      return { key: change.active ? "note.activate" : "note.deactivate", value: { note: change.entityId } }
    case "CardLorebook":
      return { key: "lorebook.embedded", value: { entity: change.entityId, on: change.on } }
    case "RemoveLorebook":
      return { key: "lorebook.remove", value: { ref: change.ref } }
    case "LoreBelowHistory":
      return { key: "lorebook.below_history", value: { on: change.on } }
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
  // Background writes outlive the request, not the server.
  const scope = yield* Effect.scope

  const userId = Effect.map(CurrentUser, (user) => user.id)

  /** Stores the summaries a shell read computed, after answering, in parts so other writes go between them. */
  const storeFresh = (id: UserId, fresh: ReadonlyArray<ChatSummaries>) =>
    fresh.length === 0
      ? Effect.void
      : Effect.forEach(
          Array.from({ length: Math.ceil(fresh.length / 250) }, (_, n) => fresh.slice(n * 250, n * 250 + 250)),
          (chats) => writer.StoreForkSummaries({ userId: id, chats }),
          { discard: true }
        ).pipe(
          Effect.catchCause((cause) => Effect.logWarning("StoreForkSummaries failed", cause)),
          Effect.forkIn(scope),
          Effect.asVoid
        )

  /**
   * The fold of the chat's state after `slotId`, with every card it names, by the name and
   * avatar of the version the chat uses there (its own version's, say).
   */
  const castAt = (user: UserId, chatId: ChatId, slotId: SlotId | null, forkId?: ForkId | null) =>
    Effect.map(castsAt(user, chatId, [slotId], forkId), ([cast]) => cast!)

  /**
   * The casts at several positions of one fork, as `castAt` reads each: the state at each, then
   * the cards once for every position that binds them alike, and the role projections once.
   * A chat's messages display at their own positions, one cast each (GetCasts).
   */
  const castsAt = (user: UserId, chatId: ChatId, slotIds: ReadonlyArray<SlotId | null>, forkId?: ForkId | null) =>
    Effect.gen(function* () {
      const positions = yield* Effect.forEach(
        slotIds,
        (slotId) =>
          Effect.map(
            reader.StateEventsAt({ userId: user, chatId, slotId, forkId: forkId ?? null, displayEnd: true }),
            (events) => ({ slotId, events, state: foldState(events) })
          ),
        { concurrency: 2 }
      )
      const idsOf = ({ events, state }: (typeof positions)[number]) => castIds(events, state)
      // One read of the cards for each set of version bindings among the positions.
      const groups = new Map<string, { bindings: ReturnType<typeof bindingsOf>; ids: Set<string> }>()
      for (const position of positions) {
        const bindings = bindingsOf(position.state)
        const key = JSON.stringify(bindings)
        const group = groups.get(key) ?? { bindings, ids: new Set<string>() }
        for (const id of idsOf(position)) group.ids.add(id)
        groups.set(key, group)
      }
      const read = new Map<string, ReadonlyArray<CastCard>>()
      for (const [key, group] of groups)
        read.set(
          key,
          yield* reader.CastCards({
            userId: user,
            entityIds: [...group.ids] as Array<Cast["participants"][number]>,
            chat: { chatId, bindings: group.bindings }
          })
        )
      const roleProjections = yield* reader.RoleProjections()
      return positions.map((position) => {
        const ids = idsOf(position)
        const all = read.get(JSON.stringify(bindingsOf(position.state)))!
        const cards = all.filter((card) => ids.includes(card.entityId))
        return castOf(position.slotId, position.state, cards, roleProjections)
      })
    })

  /** Every card the state names: the cast, and those departed that still name messages they wrote. */
  const castIds = (events: Effect.Success<ReturnType<typeof reader.StateEventsAt>>, state: ChatState) => {
    // Departed cards still name the messages they wrote, including old personas and
    // impersonated turns. Retain their faces without adding them to the active cast.
    const previous = events.flatMap(({ data }) => {
      switch (data.key) {
        case "card.swap":
          return [data.value.replaces, data.value.entity]
        case "participant.join":
        case "participant.leave":
          return [data.value.entity]
        case "played_by_me.set":
          return data.value.entities
        default:
          return []
      }
    })
    return [...new Set([...state.participants, ...state.playedByMe, ...previous])]
  }

  const castOf = (
    slotId: SlotId | null,
    state: ChatState,
    cards: ReadonlyArray<CastCard>,
    roleProjections: Cast["roleProjections"]
  ) => {
    const persona = cards.find((card) => card.entityId === state.playedByMe.at(-1))
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
      listedLorebooks: state.listedLorebooks as Cast["listedLorebooks"],
      loreBelowHistory: state.loreBelowHistory ?? true,
      macroBindings: state.macroBindings,
      macroNames: {
        user: state.macroBindings.user ?? ((persona?.modelName ?? persona?.name) || "User"),
        char:
          state.macroBindings.char ??
          state.participants
            .filter((id) => !state.playedByMe.includes(id))
            .flatMap((id) => {
              const card = cards.find((c) => c.entityId === id)
              return card ? [card.modelName ?? card.name] : []
            })
            .join(", ")
      },
      rolesProjection: state.rolesProjection,
      roleProjections,
      cards
    })
  }

  const handlers = {
    // The summaries the read computed are stored after the answer, never before it
    // (db/forkSummaries.ts); a failure only leaves them for the next read to compute.
    GetShellLibrary: () =>
      Effect.flatMap(userId, (id) =>
        reader.ShellLibrary({ userId: id }).pipe(
          Effect.tap(({ fresh }) => storeFresh(id, fresh)),
          // Decoded from the reader already: no second validation of thousands of rows.
          Effect.map(({ fresh: _, ...library }) => new ShellLibrary(library, { disableChecks: true }))
        )
      ).pipe(internal("GetShellLibrary")),
    GetShellCards: () =>
      Effect.flatMap(userId, (id) =>
        reader.ShellCards({ userId: id }).pipe(
          Effect.tap(({ fresh }) => storeFresh(id, fresh)),
          Effect.map(({ fresh: _, ...cards }) => new ShellCards(cards, { disableChecks: true }))
        )
      ).pipe(internal("GetShellCards")),
    GetShellForks: (view) =>
      Effect.flatMap(userId, (id) =>
        reader.ShellForks({ userId: id, view }).pipe(
          Effect.tap(({ fresh }) => storeFresh(id, fresh)),
          Effect.map(({ fresh: _, ...forks }) => new ShellForks(forks, { disableChecks: true }))
        )
      ).pipe(internal("GetShellForks")),
    SetChatPin: (input) =>
      Effect.flatMap(userId, (id) => writer.SetChatPin({ ...input, userId: id })).pipe(internal("SetChatPin")),
    SetHomePinsCollapsed: (input) =>
      Effect.flatMap(userId, (id) => writer.SetHomePinsCollapsed({ ...input, userId: id })).pipe(
        internal("SetHomePinsCollapsed")
      ),
    SetCardFavourite: (input) =>
      Effect.flatMap(userId, (id) => writer.SetCardFavourite({ ...input, userId: id })).pipe(
        internal("SetCardFavourite")
      ),
    ListCards: () => Effect.flatMap(userId, (id) => reader.ListCards({ userId: id })).pipe(internal("ListCards")),
    LorebookPresets: ({ ref }) =>
      Effect.flatMap(userId, (id) => reader.LorebookPresets({ userId: id, ref })).pipe(internal("LorebookPresets")),
    GetCardPromptUse: () =>
      Effect.flatMap(userId, (id) => reader.GetCardPromptUse({ userId: id })).pipe(internal("GetCardPromptUse")),
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
            const options = offeredGreetings(card, new Set(cards.filter((entity) => entity !== persona)).size)
            const picked =
              greeters === undefined && cards.length > 1 && !(greeter.entityId === cards[0] && greeting !== null)
                ? (options[Math.floor(Math.random() * options.length)]?.index ?? 0)
                : (greetingPick(options, greeter.greeting)?.index ?? 0)
            const fields = { description: card.description, personality: card.personality, scenario: card.scenario }
            const names = {
              user: player?.modelName ?? player?.name ?? "User",
              char: card.card.modelName ?? card.card.name
            }
            return {
              entityId: greeter.entityId,
              // A single card's greeting as asked, or a group's preview/random choice.
              greeting: picked,
              // Resolve the registry once: workers persist this trusted snapshot instead
              // of consulting a separate registry in another isolate.
              options: options.map((option) => ({
                index: option.index,
                text: option.text,
                frozen: freezeTemplate(
                  option.text,
                  fields,
                  names,
                  option.index === picked ? (greeter.frozen ?? {}) : {}
                )
              }))
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
            versionId: result.version.id,
            ...(result.chat.currentForkId === null ? {} : { forkId: result.chat.currentForkId })
          })
        }
        const { entry } = yield* reader.GetSlot({ userId: id, slotId: result.slotId })
        return { entry, chat: result.chat }
      }).pipe(Effect.uninterruptible, internal("StartChat")),

    GetCast: ({ chatId, slotId, forkId }) =>
      Effect.flatMap(userId, (id) => castAt(id, chatId, slotId, forkId)).pipe(internal("GetCast")),

    GetCasts: ({ chatId, slotIds, forkId }) =>
      Effect.flatMap(userId, (id) => castsAt(id, chatId, slotIds, forkId)).pipe(internal("GetCasts")),

    // The cards as the next request reads them after `slotId`: the bindings there decide.
    ListChatCards: ({ chatId, slotId, entityIds, forkId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const state = foldState(
          yield* reader.StateEventsAt({ userId: id, chatId, slotId, forkId: forkId ?? null, displayEnd: true })
        )
        return yield* reader.ChatCards({ userId: id, chatId, entityIds, bindings: bindingsOf(state) })
      }).pipe(internal("ListChatCards")),

    ForkCardForChat: (input) =>
      Effect.gen(function* () {
        const id = yield* userId
        const made = yield* writer
          .ForkCardForChat({ userId: id, ...input })
          .pipe(
            Effect.catchTag("RefOperationRefused", (error) => Effect.fail(new EditRefused({ message: error.reason })))
          )
        hub.publish(input.chatId, { _tag: "State" })
        for (const choice of made.choices) hub.publish(input.chatId, { _tag: "ComposerChoice", choice })
        hub.publish(input.chatId, {
          _tag: "Queue",
          queue: yield* reader.ListQueued({ userId: id, chatId: input.chatId })
        })
        yield* warmth.refreshUser(id)
        return made.ref
      }).pipe(internal("ForkCardForChat")),

    ChangeCast: ({ chatId, slotId, change, forkId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        if (["Model", "Preset", "DefaultModel", "DefaultPreset"].includes(change._tag)) {
          yield* reader.StateEventsAt({ userId: id, chatId, slotId, forkId: forkId ?? null, displayEnd: true })
          const selection =
            change._tag === "Model"
              ? { model: { connection: change.connection, model: change.model } }
              : change._tag === "Preset"
                ? { preset: change.ref }
                : change._tag === "DefaultModel"
                  ? { model: null }
                  : { preset: null }
          // A model or preset change names no summarization setting, so it can't be refused as one.
          yield* writer
            .ChangeGenerationDefaults({ userId: id, change: selection })
            .pipe(Effect.catchTag("LcmSettingsInvalid", (error) => Effect.die(error)))
          yield* warmth.refreshUser(id)
        } else if (change._tag === "Persona") {
          const before = yield* castAt(id, chatId, slotId, forkId)
          const persona = new Set(before.cards.flatMap((card) => (card.persona ? [card.entityId] : [])))
          yield* writer.AddStateEvents({
            userId: id,
            chatId,
            forkId: forkId ?? null,
            slotId,
            displayEnd: true,
            data: [
              ...(before.participants.includes(change.entityId)
                ? []
                : [toEvent({ _tag: "Join", entityId: change.entityId })]),
              toEvent({ _tag: "PlayedByMe", entityIds: [change.entityId] }),
              ...before.playedByMe
                .filter((e) => e !== change.entityId && before.participants.includes(e) && persona.has(e))
                .map((e) => toEvent({ _tag: "Leave", entityId: e }))
            ]
          })
        } else {
          yield* writer.AddStateEvent({
            userId: id,
            chatId,
            forkId: forkId ?? null,
            slotId,
            displayEnd: true,
            versionId: null,
            scope: null,
            data: toEvent(change)
          })
        }
        hub.publish(chatId, { _tag: "State" })
        return yield* castAt(id, chatId, slotId, forkId)
      }).pipe(internal("ChangeCast")),

    // The notes the context assembler reads at this position: the chat's own and its characters'.
    ListChatNotes: ({ chatId, slotId, forkId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const events = yield* reader.StateEventsAt({
          userId: id,
          chatId,
          slotId,
          forkId: forkId ?? null,
          displayEnd: true
        })
        const state = foldState(events)
        // Every card of the cast, the ones the user plays included: a persona note is a card's note.
        const cards = [...state.participants, ...state.playedByMe.filter((e) => !state.participants.includes(e))]
        const switches = noteSwitches(events)
        const entries = yield* reader.ChatNoteEntries({
          userId: id,
          chatId,
          forkId: forkId ?? null,
          slotId,
          cards: cards as Array<EntityId>
        })
        return yield* Effect.forEach(entries, (entry) =>
          Effect.gen(function* () {
            const revisionId = state.noteRevisions[entry.ref.entityId] as RevisionId | undefined
            const pinned =
              entry.card !== null && revisionId
                ? yield* reader.GetRevisionDoc({ userId: id, refId: entry.ref.id, revisionId })
                : null
            const resolved = pinned
              ? {
                  ref: { ...entry.ref, headRevisionId: revisionId! },
                  // A linked slot keeps showing its shared note's text.
                  doc: entry.linked ? { ...pinned, content: entry.doc["content"] } : pinned
                }
              : entry
            const onByDefault = entry.card !== null && resolved.doc["on_by_default"] === true
            return new ChatNote({
              ...entry,
              ...resolved,
              onByDefault,
              active: switches.get(entry.ref.entityId) ?? onByDefault
            })
          })
        )
      }).pipe(internal("ListChatNotes")),

    CreateChatNote: ({ chatId, title, link, forkId }) =>
      Effect.flatMap(userId, (id) =>
        writer.CreateChatNote({
          userId: id,
          chatId,
          title,
          ...(forkId === undefined ? {} : { forkId }),
          ...(link === undefined ? {} : { link })
        })
      ).pipe(internal("CreateChatNote")),

    GetGlobalRegex: () =>
      Effect.flatMap(userId, (id) => reader.GetGlobalRegex({ userId: id })).pipe(internal("GetGlobalRegex")),
    SetGlobalRegex: ({ scripts, expectedRevision }) =>
      Effect.flatMap(userId, (id) =>
        // The next context's prompt scripts change with them.
        writer.SetGlobalRegex({ userId: id, scripts, expectedRevision }).pipe(Effect.tap(() => warmth.refreshUser(id)))
      ).pipe(internal("SetGlobalRegex")),

    ListQueued: ({ chatId }) =>
      Effect.flatMap(userId, (id) => reader.ListQueued({ userId: id, chatId })).pipe(internal("ListQueued")),

    EditQueued: ({ queuedId, content, speakerEntityId, expectedRowVersion, draft }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const { queued, queue } = yield* writer.EditQueued({
          userId: id,
          queuedId,
          content,
          speakerEntityId,
          ...(draft === undefined ? {} : { draft }),
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
