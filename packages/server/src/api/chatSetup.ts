import { snapshotState, libraryView, cardsView, forksView } from "../db/shellViews.ts"
import type { ShellForksView } from "@dreamspan/shared/chatSetupApi.ts"
import { OperationCall } from "../agent/operations.ts"
import { chatNotesAt } from "../chat/chatNotesAt.ts"
import { offeredGreetings, greetingPick } from "@dreamspan/shared/greetings.ts"
import { EditRefused } from "@dreamspan/shared/editorApi.ts"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
// RPC handlers for chat setup, speakers and the send queue (@dreamspan/shared/chatSetupApi.ts).
// Every handler acts as the authenticated user; storage enforces ownership, so another
// user's ids are NotFound. Changes are published to the chat's subscribers.
import { type AppApi, CurrentUser } from "@dreamspan/shared/api.ts"
import { CastCard, type ChatId, type EntityId, type ForkId, type SlotId } from "@dreamspan/shared/chat.ts"
import { GenerationUnavailable } from "@dreamspan/shared/chatApi.ts"
import {
  Cast,
  CardForChat,
  type CastChange,
  ShellCards,
  ShellForks,
  ShellLibrary
} from "@dreamspan/shared/chatSetupApi.ts"
import { StartChatInput } from "@dreamspan/shared/chatStart.ts"
import { cardTextOfDoc } from "../db/cards.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { awayAt } from "@dreamspan/shared/knowledge.ts"
import { type ChatState, foldState, type StateEventData } from "@dreamspan/shared/state.ts"
import { Effect, Option, Queue, Schema, Semaphore, Stream } from "effect"
import { ChatHub } from "../chat/ChatHub.ts"
import { Generations } from "../chat/Generations.ts"
import { Generator } from "../chat/Generator.ts"
import { Reader, Writer } from "../db/Database.ts"
import type { ChatSummaries } from "../db/forkSummaries.ts"
import { shellCardsUpdate, shellForksUpdate } from "@dreamspan/shared/shellUpdates.ts"
import { freezeTemplate } from "../chat/macros.ts"
import { internal } from "./internal.ts"
import { WorkshopFiles } from "../files/WorkshopFiles.ts"
import { remoteOf } from "@dreamspan/shared/cardSources.ts"
import { NotFound, ServerError } from "@dreamspan/shared/errors.ts"
import { CardSources } from "../sources/CardSources.ts"

/** How long a branch list waits for the shared shell snapshot before it lists the rows stored so far. */
export const PARTIAL_AFTER = "300 millis"
/** How often a branch list that is filling in is read again while the first pass goes on. */
const PROGRESS_EVERY = "1 second"

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
    case "Away":
      return { key: "away.set", value: { entity: change.entityId, away: change.away } }
    case "Role":
      return { key: "cast.role", value: { entity: change.entityId, role: change.role } }
    case "PlayedByMe":
      return { key: "played_by_me.set", value: { entities: change.entityIds } }
    case "Model":
      return { key: "model.binding", value: { connection: change.connection, model: change.model } }
    case "Preset":
      return { key: "preset.binding", value: change.ref === null ? {} : { ref: change.ref } }
    case "DefaultModel":
      return { key: "model.unbind", value: {} }
    case "DefaultPreset":
      return { key: "preset.unbind", value: {} }
    case "SubagentModels":
      return { key: "subagents.models", value: { picks: change.picks } }
    case "SummaryModel":
      return change.model === null
        ? { key: "model.unbind", value: {} }
        : { key: "model.binding", value: { connection: change.model.connection, model: change.model.model } }
    case "MacroBinding":
      return change.value === null
        ? { key: "macro.unbind", value: { name: change.name } }
        : { key: "macro.binding", value: { name: change.name, value: change.value } }
    case "Roles":
      return { key: "roles.projection", value: change.projection }
    case "MergeLayout":
      return { key: "merge.layout", value: change.layout }
    case "ContextPerSpeaker":
      return { key: "context.per_speaker", value: change.view }
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
    case "HtmlDepth":
      return { key: "context.html_depth", value: change.depth }
    case "WorkshopFolder":
      // The inode is the host's to find (ChangeCast); a bare path is only a fallback.
      return { key: "workshop.folder", value: { path: change.path, inode: null } }
    case "ReplyOrder":
      return { key: "reply.order", value: change.order }
    case "ReplySingle":
      return { key: "reply.single", value: { on: change.on } }
    case "CardsRotation":
      return { key: "cards.rotation", value: { on: change.on } }
    case "AgentEnabled":
      return { key: "agent.enabled", value: { on: change.on } }
    case "AgentTools":
      return { key: "agent.tools", value: { tools: change.tools } }
    case "SendPresence":
      return { key: "agent.send_presence", value: { mode: change.mode } }
    case "RequestCap":
      return { key: "agent.request_cap", value: { cap: change.cap } }
    case "OutputContract":
      return { key: "output.contract", value: change.contract }
    case "DecisionPoints":
      return { key: "decision.points", value: { off: [...new Set(change.off)] } }
    case "AgentPermission":
      return { key: "agent.permission", value: { ...change.target, on: change.on } }
    case "McpConnection":
      return { key: "agent.mcp", value: { connection: change.connection, on: change.on } }
  }
}

const StartChatPayload = Schema.Struct(StartChatInput)
type StartChatPayload = typeof StartChatPayload.Type

/** A source's card as a pending chat reads it, from the file adding it would store. */
const draftCardOf = (entityId: EntityId, docJson: string) => {
  const text = cardTextOfDoc(entityId, docJson)
  const { avatarCrop: _, ...card } = text.card
  return new CardForChat({
    card: new CastCard({ ...card, avatarMediaId: null }),
    greetings: text.greetings,
    groupGreetings: text.groupGreetings,
    description: text.description,
    personality: text.personality,
    scenario: text.scenario
  })
}

/**
 * A new chat's greetings as `StartChat` writes them: who greets (the preview's choices, else
 * every card in the supplied order), each greeter's greetings, and every greeting's random and
 * time macros frozen, whatever the client sent: the values it saw in the preview are kept, and
 * any it didn't send are drawn now. `PreviewChat` draws the same way.
 */
export const drawGreeters = <E>(
  reader: Reader["Service"],
  id: UserId,
  input: Pick<StartChatPayload, "cards" | "persona" | "greeting"> & {
    readonly frozen: StartChatPayload["frozen"] | undefined
    readonly greeters: StartChatPayload["greeters"] | undefined
  },
  cardForChat: (entityId: EntityId) => Effect.Effect<CardForChat, E>,
  /** `picked`: only each greeter's picked greeting, frozen (a preview reads no other). */
  only: "all" | "picked" = "all"
) =>
  Effect.gen(function* () {
    const { cards, persona, greeting, frozen, greeters } = input
    // The names the greetings show with: the persona's and each card's, as in the preview.
    const [player] = persona === null ? [] : yield* reader.CastCards({ userId: id, entityIds: [persona] })
    const asked =
      greeters ??
      cards.map((entityId, index) => ({
        entityId,
        greeting: index === 0 ? (greeting ?? 0) : 0,
        frozen: index === 0 ? frozen : undefined
      }))
    return yield* Effect.forEach(asked, (greeter) =>
      Effect.map(cardForChat(greeter.entityId), (card) => {
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
          options: (only === "all" ? options : options.filter((option) => option.index === picked)).map((option) => ({
            index: option.index,
            text: option.text,
            ...(option.groupOnly ? { groupOnly: true } : {}),
            frozen: freezeTemplate(option.text, fields, names, option.index === picked ? (greeter.frozen ?? {}) : {})
          }))
        }
      })
    )
  })

/**
 * The first request of a chat not sent yet (`PreviewChat`, DESIGN §2.1): `StartChat`'s
 * preparation, then the request built over stand-ins (db/draftSources.ts). Nothing is written,
 * no generation starts, and no provider is asked anything, not even a token count. A card from
 * a card source reads the file adding it would store, from the source's cache.
 */
export const makeDraftPreviewHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const sources = yield* Effect.serviceOption(CardSources)
  return {
    PreviewChat: ({ cards, persona, greeting, first, frozen, greeters, replier }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const id = user.id
        const remote = [...new Set(cards)].flatMap((entityId) => {
          const from = remoteOf(entityId)
          return from === null ? [] : [{ entityId, ...from }]
        })
        if (persona !== null && remoteOf(persona) !== null) return yield* new NotFound({ entity: "card", id: persona })
        if (remote.length > 0 && Option.isNone(sources))
          return yield* new NotFound({ entity: "card", id: remote[0]!.entityId })
        // Every card it names is the caller's, as StartChat's writes require: the persona, and
        // who speaks or replies is one of the chat's cards.
        if (persona !== null) yield* reader.GetCardForChat({ userId: id, entityId: persona })
        for (const greeter of greeters ?? [])
          if (!cards.includes(greeter.entityId)) return yield* new NotFound({ entity: "card", id: greeter.entityId })
        const members = new Set<string>([...cards, ...(persona === null ? [] : [persona])])
        for (const named of [first.speakerEntityId, replier ?? null])
          if (named !== null && !members.has(named)) return yield* new NotFound({ entity: "card", id: named })
        const fromSources = new Map(
          yield* Effect.forEach(remote, (card) =>
            Effect.map(
              sources.pipe(Option.getOrThrow).preparePreview(user, card.sourceId, card.remoteId),
              ({ payload }) => [card.entityId as string, payload.file] as const
            ).pipe(
              Effect.catchTag("SourceFailed", (error) =>
                Effect.fail(new ServerError({ message: `The card couldn't be read. ${error.message}` }))
              )
            )
          )
        )
        const localCards = new Map(
          yield* Effect.forEach(
            [...new Set(cards)].filter((entityId) => remoteOf(entityId) === null),
            (entityId) =>
              Effect.map(reader.GetCardForChat({ userId: id, entityId }), (card) => [entityId, card] as const)
          )
        )
        const drawn = yield* drawGreeters(
          reader,
          id,
          { cards, persona, greeting, frozen, greeters },
          (entityId) => {
            const file = fromSources.get(entityId)
            return file
              ? Effect.succeed(draftCardOf(entityId, file.docJson))
              : Effect.succeed(localCards.get(entityId)!)
          },
          "picked"
        )
        return yield* reader.AssembleDraftChat({
          userId: id,
          cards,
          persona,
          greeters: drawn,
          first,
          replier: replier ?? null,
          remote: [...fromSources].map(([entity, file]) => ({
            entity,
            docJson: file.docJson,
            notes: [...(file.noteDocJson === null ? [] : [file.noteDocJson]), ...(file.notesDocJson ?? [])]
          })),
          now: Date.now()
        })
      }).pipe(internal("PreviewChat")),

    // The request a chat's next reply would send, assembled and counted in a reader: nothing is
    // sent. The chat, leaf and fork are checked as the caller's first.
    GetNextRequest: ({ chatId, leafSlotId, forkId }) =>
      Effect.gen(function* () {
        const { id } = yield* CurrentUser
        yield* reader.NextContextAccess({ userId: id, chatId, leafSlotId, forkId: forkId ?? null })
        return yield* reader.NextRequest({ userId: id, chatId, leafSlotId, forkId: forkId ?? null })
      }).pipe(internal("GetNextRequest"))
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
})

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
  const files = yield* WorkshopFiles
  const warmth = yield* CacheWarmth
  const hub = yield* ChatHub
  const generations = yield* Generations
  const generator = yield* Generator
  // A first send with a card from a card source adds it (spec/CARD-SOURCES.md §4.5).
  const sources = yield* Effect.serviceOption(CardSources)
  // Background writes outlive the request, not the server.
  const scope = yield* Effect.scope

  const userId = Effect.map(CurrentUser, (user) => user.id)

  const decoded = new WeakMap<object, ReturnType<typeof snapshotState>>()
  const decode = (snapshot: Parameters<typeof snapshotState>[0]) => {
    const known = decoded.get(snapshot)
    if (known) return known
    const state = snapshotState(snapshot)
    decoded.set(snapshot, state)
    return state
  }
  const shellState = (id: UserId) => reader.ShellMaterialize({ userId: id }).pipe(Effect.map(decode))
  const libraries = new WeakMap<object, ReturnType<typeof libraryView>>()
  const readLibrary = (id: UserId) =>
    shellState(id).pipe(
      Effect.map((decoded) => {
        const known = libraries.get(decoded)
        if (known) return known
        const library = libraryView(decoded.state)
        libraries.set(decoded, library)
        return library
      })
    )
  const libraryResponses = new WeakMap<object, ShellLibrary>()
  const readCards = (id: UserId) => shellState(id).pipe(Effect.map(({ state }) => cardsView(state)))
  const readForks = (id: UserId, view: ShellForksView) =>
    shellState(id).pipe(Effect.map(({ state, labels }) => forksView(state, view, labels)))
  /**
   * The branch lists don't wait for a cold library's first pass (seconds to minutes at scale):
   * the shared snapshot if it is ready within `PARTIAL_AFTER`, else one from the stored summaries
   * alone, its other rows `pending` (`loading` says how many are ready). The pass goes on meanwhile.
   */
  const readForksNow = (id: UserId, view: ShellForksView) =>
    reader.ShellMaterialize({ userId: id }).pipe(
      Effect.timeoutOption(PARTIAL_AFTER),
      Effect.flatMap(
        Option.match({
          onSome: (snapshot) => Effect.succeed(snapshot),
          onNone: () => reader.ShellMaterializePartial({ userId: id })
        })
      ),
      Effect.map((snapshot) => {
        const { state, labels } = decode(snapshot)
        return forksView(state, view, labels)
      })
    )

  /** Store a shared snapshot once, asynchronously, in parts so other writes go between them. */
  const storing = new WeakSet<ReadonlyArray<ChatSummaries>>()
  const storeFresh = (id: UserId, fresh: ReadonlyArray<ChatSummaries>) =>
    Effect.suspend(() => {
      if (fresh.length === 0 || storing.has(fresh)) return Effect.void
      storing.add(fresh)
      return Effect.forEach(
        Array.from({ length: Math.ceil(fresh.length / 250) }, (_, n) => fresh.slice(n * 250, n * 250 + 250)),
        (chats) => writer.StoreForkSummaries({ userId: id, chats }),
        { discard: true }
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => storing.delete(fresh)).pipe(
            Effect.andThen(Effect.logWarning("StoreForkSummaries failed", cause))
          )
        ),
        (effect) => Effect.forkIn(effect, scope),
        Effect.asVoid
      )
    })

  // Subscribe before the first read. A one-place signal coalesces bursts without
  // dropping a change that arrives during a read; no streamed token triggers this.
  const shellGates = new Map<UserId, Semaphore.Semaphore>()
  // `filling`: the answer has rows the first pass hasn't read yet. It is read again once the
  // pass is done or `PROGRESS_EVERY` from now, whichever is first, so the rows fill in as it goes.
  const watchShell = <A, E>(
    read: (id: UserId, live: boolean) => Effect.Effect<A, E>,
    filling?: (answer: A) => boolean
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const id = yield* userId
        let initial = true
        const gate = shellGates.get(id) ?? Semaphore.makeUnsafe(1)
        shellGates.set(id, gate)
        const signals = yield* Queue.dropping<void>(1)
        const streamScope = yield* Effect.scope
        yield* Effect.addFinalizer(() => Queue.shutdown(signals))
        yield* hub.listen(() => {
          Queue.offerUnsafe(signals, undefined)
        })
        const again = Effect.raceFirst(
          Effect.ignore(reader.ShellMaterialize({ userId: id })),
          Effect.sleep(PROGRESS_EVERY)
        ).pipe(Effect.andThen(Effect.sync(() => Queue.offerUnsafe(signals, undefined))), Effect.forkIn(streamScope))
        return Stream.concat(Stream.succeed(undefined), Stream.fromQueue(signals)).pipe(
          Stream.mapEffect(() => {
            const reading = read(id, !initial).pipe(
              Effect.tap((answer) =>
                Effect.suspend(() => {
                  initial = false
                  return filling?.(answer) === true ? Effect.asVoid(again) : Effect.void
                })
              )
            )
            return initial ? reading : gate.withPermit(reading)
          }),
          Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b))
        )
      })
    )

  /**
   * The fold of the chat's state after `slotId`, with every card it names, by the name and
   * avatar of the version the chat uses there (its own version's, say).
   */
  const castAt = (user: UserId, chatId: ChatId, slotId: SlotId | null, forkId?: ForkId | null, displayEnd = true) =>
    Effect.map(castsAt(user, chatId, [slotId], forkId, displayEnd), ([cast]) => cast!)

  /**
   * The casts at several positions of one fork, as `castAt` reads each: the state at each, then
   * the cards once for every position that binds them alike, and the role projections once.
   * A chat's messages display at their own positions, one cast each (GetCasts).
   */
  const castsAt = (
    user: UserId,
    chatId: ChatId,
    slotIds: ReadonlyArray<SlotId | null>,
    forkId?: ForkId | null,
    displayEnd = true
  ) =>
    Effect.gen(function* () {
      const positions = yield* Effect.forEach(
        slotIds,
        (slotId) =>
          Effect.map(
            reader.StateEventsAt({ userId: user, chatId, slotId, forkId: forkId ?? null, displayEnd }),
            (events) => ({ slotId, events, state: foldState(events) })
          ),
        { concurrency: 2 }
      )
      const idsOf = ({ events, state }: (typeof positions)[number]) => castIds(events, state)
      // One read of the cards for each set of version bindings among the positions.
      const groups = new Map<
        string,
        { bindings: ReturnType<typeof bindingsOf>; ids: Set<string>; active: Set<EntityId> }
      >()
      for (const position of positions) {
        const bindings = bindingsOf(position.state)
        const key = JSON.stringify(bindings)
        const group = groups.get(key) ?? { bindings, ids: new Set<string>(), active: new Set<EntityId>() }
        for (const id of idsOf(position)) group.ids.add(id)
        for (const id of [...position.state.participants, ...position.state.playedByMe])
          group.active.add(id as EntityId)
        groups.set(key, group)
      }
      const read = new Map<string, ReadonlyArray<CastCard>>()
      for (const [key, group] of groups)
        read.set(
          key,
          yield* reader.CastCards({
            userId: user,
            entityIds: [...group.ids] as Array<Cast["participants"][number]>,
            chat: {
              chatId,
              bindings: group.bindings,
              history: {
                forkId: forkId ?? null,
                slotId: slotIds[0] ?? null,
                active: [...group.active],
                ...(!displayEnd ? { through: true } : {})
              }
            }
          })
        )
      const roleProjections = yield* reader.RoleProjections()
      const mergeLayouts = yield* reader.MergeLayouts()
      const contextViews = yield* reader.ContextViews()
      return positions.map((position) => {
        const ids = idsOf(position)
        const all = read.get(JSON.stringify(bindingsOf(position.state)))!
        const cards = all.filter((card) => ids.includes(card.entityId))
        return castOf(position.slotId, position.state, cards, roleProjections, mergeLayouts, contextViews)
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
    roleProjections: Cast["roleProjections"],
    mergeLayouts: Cast["roleProjections"] = [],
    contextViews: Cast["roleProjections"] = []
  ) => {
    const persona = cards.find((card) => card.entityId === state.playedByMe.at(-1))
    return new Cast({
      slotId,
      participants: state.participants as Cast["participants"],
      absent: state.absent as Cast["absent"],
      ...(awayAt(state).length ? { away: awayAt(state) as Cast["absent"] } : {}),
      ...(Object.keys(state.roles).length ? { roles: state.roles } : {}),
      playedByMe: state.playedByMe as Cast["playedByMe"],
      model: (state.modelBindings[""] ?? null) as Cast["model"],
      ...(state.modelBindings["summarizer"]
        ? { summaryModel: state.modelBindings["summarizer"] as NonNullable<Cast["summaryModel"]> }
        : {}),
      ...(state.subagentModels ? { subagentModels: state.subagentModels } : {}),
      preset: (state.presetBindings[""]?.ref ?? null) as Cast["preset"],
      presetLocked: state.presetBindings[""] !== undefined,
      lorebooks: state.lorebooks as Cast["lorebooks"],
      cardLorebooksOff: Object.entries(state.embeddedLorebooks).flatMap(([entity, on]) =>
        on ? [] : [entity as Cast["cardLorebooksOff"][number]]
      ),
      cardLorebookBindings: state.lorebookBindings,
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
      ...(state.replyOrder === null ? {} : { replyOrder: state.replyOrder }),
      ...(state.replySingle === true ? { replySingle: true } : {}),
      ...(state.agentEnabled === null ? {} : { agentEnabled: state.agentEnabled }),
      ...(state.cardsRotation === true ? { cardsRotation: true } : {}),
      ...(state.htmlDepth === null ? {} : { htmlDepth: state.htmlDepth }),
      ...(state.workshopFolder ? { workshopFolder: state.workshopFolder } : {}),
      ...(state.agentTools ? { agentTools: state.agentTools } : {}),
      ...(state.sendPresence ? { sendPresence: state.sendPresence } : {}),
      ...(state.requestCap === undefined ? {} : { requestCap: state.requestCap }),
      ...(state.outputContract === null ? {} : { outputContract: state.outputContract }),
      ...(state.decisionsOff?.length ? { decisionsOff: state.decisionsOff } : {}),
      ...(state.agentMcp ? { agentMcp: state.agentMcp } : {}),
      roleProjections,
      ...(state.mergeLayout === null ? {} : { mergeLayout: state.mergeLayout }),
      ...(mergeLayouts.length ? { mergeLayouts } : {}),
      ...(state.contextPerSpeaker === null ? {} : { contextPerSpeaker: state.contextPerSpeaker }),
      ...(contextViews.length ? { contextViews } : {}),
      cards
    })
  }

  const handlers = {
    // The summaries the read computed are stored after the answer, never before it
    // (db/forkSummaries.ts); a failure only leaves them for the next read to compute.
    GetShellLibrary: () =>
      Effect.flatMap(userId, (id) =>
        readLibrary(id).pipe(
          Effect.tap(({ fresh }) => storeFresh(id, fresh)),
          // Decoded from the reader already: no second validation of thousands of rows.
          Effect.map((value) => {
            const known = libraryResponses.get(value)
            if (known) return known
            const { fresh: _, ...library } = value
            const response = new ShellLibrary(library, { disableChecks: true })
            libraryResponses.set(value, response)
            return response
          })
        )
      ).pipe(internal("GetShellLibrary")),
    GetShellCards: () =>
      Effect.flatMap(userId, (id) =>
        readCards(id).pipe(
          Effect.tap(({ fresh }) => storeFresh(id, fresh)),
          Effect.map(({ fresh: _, ...cards }) => new ShellCards(cards, { disableChecks: true }))
        )
      ).pipe(internal("GetShellCards")),
    WatchShellCards: () => {
      let previous: ShellCards | undefined
      return watchShell((id, live) =>
        (live
          ? reader
              .ShellCardsLive({ userId: id })
              .pipe(Effect.flatMap((answer) => (answer === null ? readCards(id) : Effect.succeed(answer))))
          : readCards(id)
        ).pipe(
          Effect.tap(({ fresh }) => storeFresh(id, fresh)),
          Effect.map(({ fresh: _, ...cards }) => new ShellCards(cards, { disableChecks: true })),
          internal("WatchShellCards")
        )
      ).pipe(
        Stream.map((next) => {
          const update = shellCardsUpdate(previous, next)
          previous = next
          return update
        })
      )
    },
    WatchShellForks: (view) => {
      let previous: ShellForks | undefined
      return watchShell(
        (id, live) =>
          (live
            ? reader
                .ShellForksLive({ userId: id, view })
                .pipe(Effect.flatMap((answer) => (answer === null ? readForksNow(id, view) : Effect.succeed(answer))))
            : readForksNow(id, view)
          ).pipe(
            Effect.tap(({ fresh }) => storeFresh(id, fresh)),
            Effect.map(({ fresh: _, ...forks }) => new ShellForks(forks, { disableChecks: true })),
            internal("WatchShellForks")
          ),
        (forks) => forks.loading !== undefined
      ).pipe(
        Stream.map((next) => {
          const update = shellForksUpdate(previous, next)
          previous = next
          return update
        })
      )
    },
    GetShellForks: (view) =>
      Effect.flatMap(userId, (id) =>
        readForks(id, view).pipe(
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
    StartChat: ({ guidance, cards, persona, greeting, first, frozen, greeters, title }) =>
      Effect.gen(function* () {
        if (first._tag === "Generate" && Option.isNone(generator)) {
          return yield* new GenerationUnavailable({
            message: "This server has nothing to generate with yet: the context assembler isn't built."
          })
        }
        const user = yield* CurrentUser
        const id = user.id
        // Cards from a card source, under their placeholder ids (§4.2): read from the source's
        // cache for the greetings, and added in the transaction that makes the chat (§4.5).
        const remote = [...new Set(cards)].flatMap((entityId) => {
          const from = remoteOf(entityId)
          return from === null ? [] : [{ entityId, ...from }]
        })
        if (persona !== null && remoteOf(persona) !== null) return yield* new NotFound({ entity: "card", id: persona })
        if (remote.length > 0 && Option.isNone(sources))
          return yield* new NotFound({ entity: "card", id: remote[0]!.entityId })
        const notSent = (error: { readonly message: string }) =>
          Effect.fail(
            new ServerError({ message: `The card couldn't be added, so the message wasn't sent. ${error.message}` })
          )
        const fromSources = new Map(
          yield* Effect.forEach(remote, (card) =>
            Effect.map(
              Effect.all({
                shown: sources.pipe(Option.getOrThrow).forChat(user, card.sourceId, card.remoteId),
                prepared: sources.pipe(Option.getOrThrow).prepareAdoption(user, card.sourceId, card.remoteId)
              }),
              ({ shown, prepared }) => [card.entityId as string, { shown: shown.card, prepared }] as const
            ).pipe(Effect.catchTag("SourceFailed", notSent))
          )
        )
        const drawn = yield* drawGreeters(reader, id, { cards, persona, greeting, frozen, greeters }, (entityId) => {
          const from = fromSources.get(entityId)
          return from ? Effect.succeed(from.shown) : reader.GetCardForChat({ userId: id, entityId })
        })
        const start = {
          guidance: guidance ?? false,
          userId: id,
          cards,
          persona,
          greeters: drawn,
          first,
          title: title ?? null
        }
        const prepared = [...fromSources.values()].map((card) => card.prepared)
        const { adopted, ...result } =
          prepared.length === 0
            ? { ...(yield* writer.StartChat(start)), adopted: undefined }
            : yield* sources.pipe(Option.getOrThrow).storingAdoptions(
                prepared,
                writer
                  .AdoptAndStartChat({
                    adopt: [...fromSources.entries()].map(([placeholder, card]) => ({
                      placeholder: placeholder as EntityId,
                      ...card.prepared.payload
                    })),
                    start
                  })
                  .pipe(Effect.catchTag("RefOperationRefused", notSent)),
                (started) => started.adopted.map((card) => !card.existing)
              )
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
        return {
          entry,
          chat: result.chat,
          composer: result.composer,
          ...(adopted === undefined
            ? {}
            : {
                adopted: adopted.map((card) => ({
                  placeholder: card.placeholder,
                  entityId: card.entityId,
                  name: fromSources.get(card.placeholder)!.prepared.name,
                  existing: card.existing
                }))
              })
        }
      }).pipe(Effect.uninterruptible, internal("StartChat")),

    GetCast: ({ chatId, slotId, forkId }) =>
      Effect.gen(function* () {
        const call = yield* OperationCall
        const exact = (call?.expected as { proof?: { storyAt?: unknown } } | undefined)?.proof?.storyAt !== undefined
        return yield* castAt(yield* userId, chatId, slotId, forkId, !exact)
      }).pipe(internal("GetCast")),

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

    ChangeCast: ({ chatId, slotId: asked, change, forkId, pending: shownPending }) =>
      Effect.gen(function* () {
        let slotId = asked
        const id = yield* userId
        const call = yield* OperationCall
        const displayEnd =
          (call?.expected as { proof?: { storyAt?: unknown } } | undefined)?.proof?.storyAt === undefined
        // A pending chat's greetings follow who's in it, as a group start's would (DESIGN §2.1):
        // its cast change and its greetings are written together, so a first send or another
        // change from another tab sees both or neither.
        const chat = yield* reader.GetChat({ userId: id, chatId })
        // Asked for on the pending page, but a first send from another tab started the chat
        // first: an ordinary cast change, after what was said, not at its start.
        if (shownPending === true && asked === null && chat.status !== "pending") slotId = chat.activeLeafSlotId
        if (["Join", "Leave", "Swap", "PlayedByMe", "Persona"].includes(change._tag) && chat.status === "pending") {
          const before = yield* castAt(id, chatId, null, forkId, displayEnd)
          const persona = new Set(before.cards.flatMap((card) => (card.persona ? [card.entityId] : [])))
          const events =
            change._tag === "Persona"
              ? [
                  ...(before.participants.includes(change.entityId)
                    ? []
                    : [toEvent({ _tag: "Join", entityId: change.entityId })]),
                  toEvent({ _tag: "PlayedByMe", entityIds: [change.entityId] }),
                  ...before.playedByMe
                    .filter((e) => e !== change.entityId && before.participants.includes(e) && persona.has(e))
                    .map((e) => toEvent({ _tag: "Leave", entityId: e }))
                ]
              : [toEvent(change as Exclude<CastChange, { readonly _tag: "Persona" }>)]
          // Greetings for everyone the change may leave in the cast; the writer takes the cast's.
          const player =
            change._tag === "Persona"
              ? change.entityId
              : change._tag === "PlayedByMe"
                ? (change.entityIds[0] ?? null)
                : (before.playedByMe[0] ?? null)
          const playing = new Set<string>(
            change._tag === "Persona"
              ? [change.entityId]
              : change._tag === "PlayedByMe"
                ? change.entityIds
                : before.playedByMe
          )
          const joining = change._tag === "Join" || change._tag === "Swap" ? [change.entityId] : []
          const candidates = [...new Set([...before.participants, ...joining])].filter((entity) => !playing.has(entity))
          const drawn = yield* drawGreeters(
            reader,
            id,
            {
              cards: candidates,
              persona: player,
              greeting: null,
              frozen: undefined,
              greeters: candidates.map((entityId) => ({ entityId, greeting: 0 }))
            },
            (entityId) => reader.GetCardForChat({ userId: id, entityId })
          )
          const synced = yield* writer.SyncPendingGreetings({
            userId: id,
            chatId,
            forkId: forkId ?? null,
            events,
            candidates: drawn
          })
          if (synced.pending) {
            if (synced.changed) hub.publish(chatId, { _tag: "Reload" })
            hub.publish(chatId, { _tag: "State" })
            return yield* castAt(id, chatId, slotId, forkId, displayEnd)
          }
          // It started since (a first send from another tab): an ordinary cast change, after what
          // was said, not at a start that has its greetings now.
          slotId = (yield* reader.GetChat({ userId: id, chatId })).activeLeafSlotId
        }
        if (change._tag === "Persona") {
          const before = yield* castAt(id, chatId, slotId, forkId, displayEnd)
          const persona = new Set(before.cards.flatMap((card) => (card.persona ? [card.entityId] : [])))
          yield* writer.AddStateEvents({
            userId: id,
            chatId,
            forkId: forkId ?? null,
            slotId,
            displayEnd,
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
        } else if (change._tag === "WorkshopFolder") {
          // A folder of the user's Files, with its inode (spec/FILES-AND-ENVIRONMENT.md §2.1), and
          // remembered for the workshop's assistant card and as the account's last pick (§2.3).
          const chat = yield* reader.GetChat({ userId: id, chatId })
          if (chat.kind !== "workshop") return yield* new NotFound({ entity: "workshop", id: chatId })
          // A folder on the server (§3.7): an admin's, under HOST_FOLDERS, by its real path; not
          // remembered for the card or among the recent folders.
          if (change.host === true) {
            const user = yield* CurrentUser
            // Never for another account, whatever the request says: as if there were no such folder.
            if (user.role !== "admin") return yield* new NotFound({ entity: "folder", id: change.path })
            const host = yield* Effect.tryPromise(() => files.hostFolders.check(change.path)).pipe(
              Effect.mapError(() => new NotFound({ entity: "folder", id: change.path }))
            )
            yield* writer.AddStateEvent({
              userId: id,
              chatId,
              forkId: forkId ?? null,
              slotId,
              displayEnd,
              versionId: null,
              scope: null,
              data: { key: "workshop.folder", value: { path: host.path, inode: host.inode, host: true } }
            })
          } else {
            const folder = yield* files
              .folderAt(id, change.path)
              .pipe(Effect.mapError(() => new NotFound({ entity: "folder", id: change.path })))
            yield* writer.AddStateEvent({
              userId: id,
              chatId,
              forkId: forkId ?? null,
              slotId,
              displayEnd,
              versionId: null,
              scope: null,
              data: { key: "workshop.folder", value: folder }
            })
            const before = yield* castAt(id, chatId, slotId, forkId, displayEnd)
            const assistant = before.cards.find((card) => !card.persona && before.participants.includes(card.entityId))
            yield* writer.RememberWorkshopFolder({ userId: id, cardId: assistant?.entityId ?? null, ...folder })
          }
        } else {
          yield* writer.AddStateEvent({
            userId: id,
            chatId,
            forkId: forkId ?? null,
            slotId,
            displayEnd,
            versionId: null,
            // The summary model is the "summarizer" role's own binding; everything else is chat-wide.
            scope: change._tag === "SummaryModel" ? "summarizer" : null,
            data: toEvent(change)
          })
        }
        hub.publish(chatId, { _tag: "State" })
        return yield* castAt(id, chatId, slotId, forkId, displayEnd)
      }).pipe(internal("ChangeCast")),

    // The notes the context assembler reads at this position: the chat's own and its characters'.
    ListChatNotes: ({ chatId, slotId, forkId }) =>
      Effect.flatMap(userId, (id) => chatNotesAt(reader, id, { chatId, slotId, forkId })).pipe(
        internal("ListChatNotes")
      ),

    CreateChatNote: ({ chatId, title, link, forkId, replaces, content }) =>
      Effect.flatMap(userId, (id) =>
        writer.CreateChatNote({
          userId: id,
          chatId,
          title,
          ...(replaces === undefined ? {} : { replaces }),
          ...(content === undefined ? {} : { content }),
          ...(forkId === undefined ? {} : { forkId }),
          ...(link === undefined ? {} : { link })
        })
      ).pipe(
        // Listed in every branch: the chat's open tabs read their notes again.
        Effect.tap(() => Effect.sync(() => hub.publish(chatId, { _tag: "State" }))),
        internal("CreateChatNote")
      ),

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
