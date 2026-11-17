// A chat not made yet (DESIGN §2.1): who's in it, who the user plays, which greeting each
// character opens with and who answers the first message, held here until the first send makes
// the chat. The pending page renders it with the saved chat's parts (header, side panel,
// message column, composer), which read it as a `ChatView` with no chat (`view`), and the side
// panel's tabs change it through these methods, as a saved chat's tabs change its session.
import { greetingPick, offeredGreetings } from "@rp/shared/greetings.ts"
import type { CastCard, ChatId, EntityId } from "@rp/shared/chat.ts"
import type { CardForChat } from "@rp/shared/chatSetupApi.ts"
import type { Caller } from "../editor/caller.ts"
import type { ChatView, Outcome } from "./session.ts"

export interface PendingState {
  /** Each character's card, in the order they greet: the chat's characters. */
  readonly greeters: ReadonlyArray<CardForChat>
  /** The greeting each greeter opens with, by its card index. */
  readonly picks: ReadonlyArray<number>
  /** Who the user plays (`{{user}}`), or null for no persona. */
  readonly persona: EntityId | null
  /** Said when a group greeting picked is no longer offered. */
  readonly fallbackNote: string
  /** Who answers the first message the user sends; null: the first character. */
  readonly replier: EntityId | null
  readonly guidance: boolean
  /** Placeholders of cards from a card source that became the user's, to their cards' ids. */
  readonly swapped: Readonly<Record<string, EntityId>>
}

/** The id a card first had here (`swapped` is the state's): a source card's placeholder, else its own. */
export const firstId = (swapped: PendingState["swapped"], id: EntityId) =>
  (Object.entries(swapped).find(([, to]) => to === id)?.[0] as EntityId | undefined) ?? id

/** A group the new chat is of: its name and the chat that names it. */
export interface PendingGroup {
  readonly name: string
  readonly chatId: ChatId
}

const characterCount = (state: Pick<PendingState, "greeters" | "persona">) =>
  new Set(state.greeters.filter((item) => item.card.entityId !== state.persona).map((item) => item.card.entityId)).size

/** The greetings each greeter offers now: group-only ones join with two characters or more. */
export const pendingOptions = (state: Pick<PendingState, "greeters" | "persona">) =>
  state.greeters.map((item) => offeredGreetings(item, characterCount(state)))

export class PendingChat {
  private state: PendingState
  private cached: { state: PendingState; view: ChatView } | null = null
  private readonly listeners = new Set<() => void>()

  /** Every card the user has but the greeters', in the library's order: who can be the persona or join. */
  private availableCards: ReadonlyArray<CastCard>
  get cards(): ReadonlyArray<CastCard> {
    return this.availableCards
  }
  readonly group: PendingGroup | null
  private readonly call: Caller

  constructor(
    cards: ReadonlyArray<CastCard>,
    greeters: ReadonlyArray<CardForChat>,
    group: PendingGroup | null,
    call: Caller,
    defaultPersona: EntityId | null = null,
    guidance = false
  ) {
    this.availableCards = cards
    this.group = group
    this.call = call
    const persona =
      [...cards, ...greeters.map((item) => item.card)].find((card) => card.entityId === defaultPersona && card.persona)
        ?.entityId ?? null
    const state = { greeters, persona }
    this.state = {
      ...state,
      // A group's chat starts at a random greeting of each, as ST starts one; a card at its first.
      picks: pendingOptions(state).map((options) =>
        group === null ? 0 : (options[Math.floor(Math.random() * Math.max(1, options.length))]?.index ?? 0)
      ),
      fallbackNote: "",
      replier: null,
      guidance,
      swapped: {}
    }
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  readonly snapshot = () => this.state

  /** Changes the state; picks no longer offered fall back to the card's first greeting, with a note. */
  change(change: (current: PendingState) => PendingState) {
    const next = change(this.state)
    const options = pendingOptions(next)
    const adjusted = next.greeters.map((_, at) => greetingPick(options[at]!, next.picks[at] ?? 0)?.index ?? -1)
    const fellBack = next.greeters.some(
      (item, at) =>
        item.groupGreetings.length > 0 &&
        (next.picks[at] ?? -1) >= item.greetings.length &&
        adjusted[at] !== next.picks[at]
    )
    this.state = {
      ...next,
      picks: adjusted,
      fallbackNote: fellBack
        ? "The selected group greeting is no longer available. Using the card’s first greeting."
        : next.fallbackNote
    }
    for (const listener of this.listeners) listener()
  }

  setPersona(id: EntityId | null) {
    this.change((current) => ({ ...current, persona: id }))
  }

  pick(at: number, index: number) {
    this.change((current) => ({
      ...current,
      fallbackNote: "",
      picks: current.picks.map((pick, i) => (i === at ? index : pick))
    }))
  }

  setReplier(id: EntityId) {
    this.change((current) => ({ ...current, replier: id }))
  }

  /** Leaves a character out of the chat, with their greeting; the first stays. */
  remove(id: EntityId) {
    this.change((current) => ({
      ...current,
      greeters: current.greeters.filter((greeter) => greeter.card.entityId !== id),
      picks: current.picks.filter((_, index) => current.greeters[index]!.card.entityId !== id)
    }))
  }

  /** Adds a character, who greets after the others; applied to the state as it is when the card arrives. */
  async join(id: EntityId): Promise<Outcome<void>> {
    const result = await this.call((client) => client("GetCardForChat", { entityId: id }))
    if (!result.ok) return result
    this.change((current) =>
      current.persona === id || current.greeters.some((item) => item.card.entityId === id)
        ? current
        : { ...current, greeters: [...current.greeters, result.value], picks: [...current.picks, 0] }
    )
    return { ok: true, value: undefined }
  }

  /**
   * A card from a card source, now the user's (Add to my cards, or Save on its tab;
   * spec/CARD-SOURCES.md §4.5): its greeter becomes their card in place, as saved, its
   * greeting picked as it was.
   */
  async swap(placeholder: EntityId, entityId: EntityId): Promise<Outcome<void>> {
    if (this.state.swapped[placeholder] !== undefined) return { ok: true, value: undefined }
    const result = await this.call((client) => client("GetCardForChat", { entityId }))
    if (!result.ok) return result
    const swapped = (id: EntityId | null) => (id === placeholder ? entityId : id)
    this.change((current) => ({
      ...current,
      swapped: { ...current.swapped, [placeholder]: entityId },
      greeters: current.greeters.map((item) => (item.card.entityId === placeholder ? result.value : item)),
      persona: swapped(current.persona),
      replier: swapped(current.replier)
    }))
    return { ok: true, value: undefined }
  }

  /** Read current cards, including a persona just created by a picker, before it is selected. */
  readonly listCards = async (): Promise<Outcome<ReadonlyArray<CastCard>>> => {
    const result = await this.call((client) => client("ListCards", undefined))
    if (!result.ok) return result
    const greeters = new Set(this.state.greeters.map((item) => item.card.entityId))
    this.availableCards = result.value.filter((card) => !greeters.has(card.entityId))
    this.change((state) => ({ ...state }))
    return result
  }

  /** The card the user plays, if any. */
  playing(state = this.state) {
    return state.persona === null
      ? null
      : (this.cards.find((card) => card.entityId === state.persona) ??
          state.greeters.find((item) => item.card.entityId === state.persona)?.card ??
          null)
  }

  /** The chat as the saved chat's parts read it: its cast, and nothing else yet. */
  view(state = this.state): ChatView {
    if (this.cached?.state === state) return this.cached.view
    const playing = this.playing(state)
    const characters = state.greeters.map((item) => item.card).filter((card) => card.entityId !== state.persona)
    const view = pendingView(characters, playing)
    this.cached = { state, view }
    return view
  }
}

/**
 * A chat not made yet as the saved chat's parts read it: its cast (`characters`, and the card the
 * user plays), and nothing else yet. A workshop not made yet reads the same (features/workshop).
 */
export const pendingView = (characters: ReadonlyArray<CastCard>, playing: CastCard | null): ChatView => {
  const cards = [...characters, ...(playing ? [playing] : [])]
  return {
    chat: null,
    forkId: null,
    leafSlotId: null,
    entries: [],
    branchNames: new Map(),
    older: null,
    newer: null,
    follow: true,
    opened: 0,
    pathRevision: 0,
    loading: false,
    error: null,
    deleted: false,
    cast: {
      participants: cards.map((card) => card.entityId),
      playedByMe: playing ? [playing.entityId] : [],
      cards,
      slotId: null,
      absent: [],
      model: null,
      preset: null,
      lorebooks: [],
      cardLorebooksOff: [],
      listedLorebooks: [],
      loreBelowHistory: true,
      macroBindings: {},
      macroNames: {
        user: playing?.modelName ?? playing?.name ?? "User",
        char: characters.map((card) => card.modelName ?? card.name).join(", ")
      },
      rolesProjection: null,
      roleProjections: []
    },
    queue: [],
    cache: null,
    history: null,
    lcm: null,
    lcmVersion: 0,
    lcmViewer: null,
    highlight: null
  }
}

/**
 * The name the chat will have once saved, so the header reads the same before and after the
 * first send: the group's, else the characters' (the server's default title, `titleFor`).
 */
export const pendingTitle = (chat: PendingChat, state: PendingState, now = Date.now()) => {
  if (chat.group !== null) return chat.group.name
  const names = state.greeters.filter((item) => item.card.entityId !== state.persona).map((item) => item.card.name)
  return names.length > 1
    ? names.join(" & ")
    : `${names[0] ?? "Chat"}, ${new Date(now).toLocaleDateString("en", { day: "numeric", month: "short" })}`
}
