import { refreshTokenCounts } from "../editor/tokenCounts.ts"
import type { ForkNoteSelection } from "@rp/shared/chatApi.ts"
// One open chat (CLIENT-FRAMEWORK §5): the loaded window of its path, kept current by its
// subscription, and the text of versions still generating. The server is the source of
// truth: the window is what reads and events said, and writes apply the server's reply.
//
// Streamed text never goes through the list. Each generating version's text is an atom
// of its own, which only its message's body reads, and deltas are applied once per
// animation frame, so a token re-renders one row.
import { sectionsDisplay } from "@rp/shared/replySections.ts"
import {
  type Chat,
  type ChatId,
  type EntityId,
  type Fork,
  type ForkId,
  type PathEntry,
  type QueuedMessage,
  type SlotId,
  type Version,
  type VersionId,
  versionInContext
} from "@rp/shared/chat.ts"
import type { Cast, CastChange } from "@rp/shared/chatSetupApi.ts"
import type { ComposerChoice } from "@rp/shared/composerApi.ts"
import type { CardFields } from "@rp/shared/macros/context.ts"
import { NotFound } from "@rp/shared/errors.ts"
import type {
  BranchSwitch,
  ChatEvent,
  MessageDraftTarget,
  PathRange,
  PathWindow,
  SendResult
} from "@rp/shared/chatApi.ts"
import type { CacheWarmth, NextContext } from "@rp/shared/inspectorApi.ts"
import type { LcmCoverage, LcmState } from "@rp/shared/lcm.ts"
import type { InsertBody, InsertedMessage } from "@rp/shared/messagesApi.ts"
import { Cause, Context, Effect, Exit, Fiber, Schedule, Stream } from "effect"
import { Atom, type AtomRegistry, AtomRegistry as Registry, Reactivity } from "effect/reactivity"
import { type AppError, describeCause } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { sessionAtom } from "../../session.ts"
import { mountedBodies, PERF, perf } from "./perf.ts"
import { positionOf } from "./position.ts"
import type { ComposerSource } from "./composerDraft.ts"
import { type Copy, copiesOf, pendingOf } from "../editor/backup.ts"
import { editorKey, MessageDraft, messageCopies, type MessageEditorKey, targetOf } from "./messageDraft.ts"
import { beforeReply, chatStateChanged } from "./replyHooks.ts"

/** How many slots one read asks for. */
const PAGE = 60
/** At most this many slots stay loaded; the far end is dropped, and read again when needed. */
const MAX_LOADED = 500
/** How long after a change to the chat the lists of chats read again: one read for a burst of changes. */
const CHATS_REREAD_MS = 1000

/** Whether this version is held behind a cold-prefix writer. */
export const waitingCache = Atom.family((_id: VersionId) => Atom.make(false))

/** The text so far of a version that's generating, by its id; null when it isn't. */
export const liveText = Atom.family((_id: VersionId) => Atom.make<string | null>(null))

/** The reasoning streamed so far by a version that's generating (DESIGN §7.4); null when it isn't. */
export const liveReasoning = Atom.family((_id: VersionId) => Atom.make<string | null>(null))
/** A generating version's reply-section panel text so far (spec/REPLY-SECTIONS.md); null when not streaming. */
export const liveSections = Atom.family((_id: VersionId) => Atom.make<string | null>(null))

export interface ChatView {
  readonly chat: Chat | null
  /** The fork shown, as the server resolved it (spec/FORK-INDEPENDENCE-DELTA.md §2.1). */
  readonly forkId: ForkId | null
  /** The path's leaf: the fork's tip, as the server resolved it. */
  readonly leafSlotId: SlotId | null
  readonly entries: ReadonlyArray<PathEntry>
  /** Live naming metadata, including fork points outside the message window. */
  readonly branchNames: ReadonlyMap<SlotId, { readonly name: string | undefined; readonly rowVersion: number }>
  /** Where to continue reading older history; null at the root. */
  readonly older: SlotId | null
  /** Where to continue reading newer history; null when the window reaches the leaf. */
  readonly newer: SlotId | null
  /** Whether a message added at the end scrolls into view: not while paging down. */
  readonly follow: boolean
  /** Bumped when the window is replaced rather than extended, so the list can position it. */
  readonly opened: number
  /** History changed, including outside the loaded window; streamed text doesn't bump this. */
  readonly pathRevision: number
  readonly loading: boolean
  readonly error: string | null
  /** The chat went to the bin while open, here or elsewhere. */
  readonly deleted: boolean
  /** Who's in the chat and its settings at the leaf shown; null until read. */
  readonly cast: Cast | null
  /** What waits behind a reply still being written (DESIGN §2.2), in order. */
  readonly queue: ReadonlyArray<QueuedMessage>
  /** Whether the provider's cache is likely warm for the next reply (DESIGN §5.5); null without an estimate. */
  readonly cache: CacheWarmth | null
  readonly history: Omit<NextContext, "warmth"> | null
  /** What stands in for older history on the path shown (DESIGN §8); null until read. */
  readonly lcm: LcmState | null
  /** Bumped each time the summaries are read and differ, so a window of coverage reads again. */
  readonly lcmVersion: number
  /** A message just inserted here, briefly highlighted where it went (spec/MESSAGE-INSERT.md §4.3); null: none. */
  readonly highlight: SlotId | null
}

type Client = AppClient["Service"]
/** The events that change loaded state, and are applied again after a read lands. */
type Replayable = Extract<ChatEvent, { readonly _tag: "Slot" | "Version" | "Chat" }>
/** What a send names of the composer draft it took its text from, which it commits. */
const commitOf = ({ draftId, session, text }: ComposerSource) => ({ draftId, session, text })

/** The draft an edit's text was typed into, to commit with it (messageDraft.ts). */
type DraftCommit = { readonly draftId: string; readonly session: number }

/** What a new version or Continue of a slot asks the composer for its guidance. */
export interface GuidanceRequest {
  readonly slotId: SlotId
  readonly kind: "version" | "continue"
}

export type Outcome<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: AppError }

const withInContext = (entry: PathEntry, version: Version) =>
  ({
    ...entry,
    version,
    inContext: versionInContext(version.status, version.content, entry.contextExcluded, version.images?.length)
  }) as PathEntry

/** The entry at `position`; unchanged without one (a window of a fork without insertions). */
const withPosition = (entry: PathEntry, position: number | undefined) =>
  position === undefined || entry.position === position ? entry : ({ ...entry, position } as PathEntry)

/** A streamed text's change (`Delta`, `Reasoning`, `Section`); `replace`: from `offset` on. */
type LiveDelta = { readonly offset: number; readonly text: string; readonly replace?: boolean }

/**
 * What a chat's page shows before its first read: a chat a pending page just saved, as its
 * first send left it (StartChatPage.tsx), so the saved page opens on it with no loading
 * state in between (owner, 2026-11-02: nothing flashes or jumps). Taken when the session starts.
 */
export type ChatSeed = Pick<ChatView, "chat" | "forkId" | "leafSlotId" | "entries" | "older" | "newer" | "cast">
const seeds = new Map<ChatId, ChatSeed>()
export const seedChat = (chatId: ChatId, seed: ChatSeed) => void seeds.set(chatId, seed)

export class ChatSession {
  private view: ChatView = {
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
    loading: true,
    error: null,
    deleted: false,
    cast: null,
    queue: [],
    cache: null,
    history: null,
    lcm: null,
    lcmVersion: 0,
    highlight: null
  }
  private readonly listeners = new Set<() => void>()
  private readonly versionListeners = new Set<(version: Version) => void>()

  /** Picker lists also hear changes to versions that aren't currently selected. */
  subscribeVersions = (listener: (version: Version) => void) => {
    this.versionListeners.add(listener)
    return () => {
      this.versionListeners.delete(listener)
    }
  }
  /** Unmounts for the live atoms kept alive while their version generates, shown or not. */
  private readonly live = new Map<VersionId, () => void>()
  /** Deltas received since the last frame, by version. */
  private readonly pending = new Map<VersionId, Array<LiveDelta>>()
  /** Reasoning received since the last frame, by version, applied as the text's deltas are. */
  private readonly pendingReasoning = new Map<VersionId, Array<LiveDelta>>()
  /** Reply-section text received since the last frame, by version, as reasoning is. */
  private readonly pendingSections = new Map<VersionId, Array<LiveDelta>>()
  private frame: number | null = null
  private hellos = 0
  private subscription: Fiber.Fiber<void, unknown> | null = null
  private disposed = false
  /** Bumped by every read that replaces the window, so an older read's reply is dropped. */
  private generation = 0
  private paging = false
  /** Reads in flight, and the events received since the first of them started (below). */
  private reads = 0
  private missed: Array<Replayable> = []

  /** Stable chat identity, available while its view is still loading. */
  readonly chatId: ChatId
  /** The fork the URL asks for; null opens the chat's current fork. */
  private requestedFork: ForkId | null
  private readonly registry: AtomRegistry.AtomRegistry

  /** The chat this session shows. */
  get id(): ChatId {
    return this.chatId
  }

  /** Queries completed since this session began already cover its initial snapshot. */
  readonly startedAt = Date.now()

  constructor(
    chatId: ChatId,
    requestedFork: ForkId | null,
    registry: AtomRegistry.AtomRegistry,
    /** The user signed in: whose browser copies of the message editors' text to replay. */
    userId: string
  ) {
    this.chatId = chatId
    this.userId = userId
    this.requestedFork = requestedFork
    this.registry = registry
    // A chat just saved from its pending page opens on what that page had, and reads it again.
    const seed = requestedFork === null ? seeds.get(chatId) : undefined
    if (seed !== undefined)
      this.view = { ...this.view, ...seed, follow: seed.newer === null, opened: 1, loading: false }
  }

  // --- For React (useSyncExternalStore)

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private readonly contextListeners = new Set<(initialSnapshot: boolean) => void>()

  /** Context notifications also invalidate prospective defaults hidden by chat bindings. */
  readonly subscribeContext = (listener: (initialSnapshot: boolean) => void) => {
    this.contextListeners.add(listener)
    return () => {
      this.contextListeners.delete(listener)
    }
  }

  readonly snapshot = () => this.view

  private update(change: Partial<ChatView>) {
    const leaf = this.view.leafSlotId
    this.view = { ...this.view, ...change }
    this.report()
    for (const listener of this.listeners) listener()
    // The cast is read at the leaf shown: another leaf may have another cast.
    if (this.view.leafSlotId !== leaf) {
      if (!this.view.loading) void this.refreshCast()
      void this.refreshContext()
      void this.refreshLcm()
    }
  }

  private readonly choiceListeners = new Set<(choice: ComposerChoice | null) => void>()
  /**
   * Calls `listener` with each composer's speaker or reply choice published to this chat
   * (speaker.ts), and with null after a reconnect, when one may have been missed.
   */
  readonly onComposerChoice = (listener: (choice: ComposerChoice | null) => void) => {
    this.choiceListeners.add(listener)
    return () => {
      this.choiceListeners.delete(listener)
    }
  }

  private contextReads = 0

  private lcmReads = 0
  /** The newest read applied: a slow read is never dropped for a newer one still in flight. */
  private lcmApplied = 0
  private lcmTimer: ReturnType<typeof setTimeout> | null = null
  private readonly lcmListeners = new Set<() => void>()

  /**
   * Called each time the summaries were read again after the server said they changed, even
   * when the layer came back the same: the backfill's state is not part of the layer.
   */
  readonly onLcmRead = (listener: () => void) => {
    this.lcmListeners.add(listener)
    return () => void this.lcmListeners.delete(listener)
  }

  /** Reads the summaries on the path shown, soon: a run of events makes one read. */
  private scheduleLcm() {
    if (this.lcmTimer !== null) return
    this.lcmTimer = setTimeout(() => {
      this.lcmTimer = null
      void this.refreshLcm()
    }, 120)
  }

  private async refreshLcm() {
    const read = ++this.lcmReads
    const forkId = this.view.forkId
    const leafSlotId = this.view.leafSlotId
    if (leafSlotId === null || this.disposed) return
    const result = await this.call((client) => client("GetLcmState", { chatId: this.chatId, forkId, leafSlotId }))
    if (
      !result.ok ||
      this.disposed ||
      read < this.lcmApplied ||
      forkId !== this.view.forkId ||
      leafSlotId !== this.view.leafSlotId
    )
      return
    this.lcmApplied = read
    for (const listener of this.lcmListeners) listener()
    // The same layer again (the leaf moved on, a reply streamed) changes nothing on screen.
    this.update({
      lcm: JSON.stringify(result.value) === JSON.stringify(this.view.lcm) ? this.view.lcm : result.value,
      lcmVersion: this.view.lcmVersion + 1
    })
  }

  /** The summaries overlapping a range of message positions on the path shown, without their text. */
  async coverage(fromPosition: number, toPosition: number, includeResolved = false): Promise<LcmCoverage | null> {
    const forkId = this.view.forkId
    const leafSlotId = this.view.leafSlotId
    if (leafSlotId === null) return null
    const result = await this.call((client) =>
      client("GetLcmCoverage", {
        forkId,
        chatId: this.chatId,
        leafSlotId,
        fromDepth: fromPosition,
        toDepth: toPosition,
        fromPosition,
        toPosition,
        includeResolved
      })
    )
    return result.ok && !this.disposed && forkId === this.view.forkId && leafSlotId === this.view.leafSlotId
      ? result.value
      : null
  }

  private async refreshContext() {
    const read = ++this.contextReads
    const forkId = this.view.forkId
    const leafSlotId = this.view.leafSlotId
    // A chat with no messages has no leaf, but its next reply still has a context (the
    // preset, the cards, the notes); before the first read there's nothing to ask about.
    if (leafSlotId === null && this.view.loading) return
    const result = await this.call((client) => client("GetNextContext", { chatId: this.chatId, leafSlotId, forkId }))
    if (
      !result.ok ||
      this.disposed ||
      read !== this.contextReads ||
      forkId !== this.view.forkId ||
      leafSlotId !== this.view.leafSlotId
    )
      return
    // Cold queries already read for this opening; retained queries still revalidate.
    // Actual server Cache events always announce a change, including the first one.
    this.apply({ _tag: "Cache", ...result.value }, null, this.view.history === null)
  }

  /** Bumped by every cast read, so an older reply is dropped. */
  private castReads = 0

  /** The cast read again: after a card's picture or cutout changed (§14.5c), what its portraits show. */
  rereadCast() {
    return this.refreshCast()
  }

  private async refreshCast() {
    const read = ++this.castReads
    const slotId = this.view.leafSlotId
    const forkId = this.view.forkId
    const result = await this.call((client) => client("GetCast", { chatId: this.chatId, slotId, forkId }))
    if (
      !result.ok ||
      read !== this.castReads ||
      this.disposed ||
      forkId !== this.view.forkId ||
      slotId !== this.view.leafSlotId
    )
      return
    // Unchanged, it stays the same object: every message row reads it.
    if (JSON.stringify(result.value) !== JSON.stringify(this.view.cast)) this.update({ cast: result.value })
  }

  // --- The cast at a message's position, for text whose macros follow the chat's state
  // there (DESIGN §5.6): a greeting's `{{user}}` is whoever the user played before it.

  private readonly positionCasts = new Map<string, Cast | "loading">()
  /** Bumped when position state changes, including a switch away and back to the same fork. */
  private positionGeneration = 0
  private readonly positionListeners = new Set<() => void>()

  readonly subscribePositions = (listener: () => void) => {
    this.positionListeners.add(listener)
    return () => {
      this.positionListeners.delete(listener)
    }
  }

  /** The cast after `slotId` (null: before the first message); undefined until read. */
  castAfter(slotId: SlotId | null): Cast | undefined {
    const key = slotId ?? ""
    const known = this.positionCasts.get(key)
    if (known !== undefined) return known === "loading" ? undefined : known
    this.positionCasts.set(key, "loading")
    const forkId = this.view.forkId
    if (this.castBatch === null || this.castBatch.forkId !== forkId) {
      const batch = { forkId, generation: this.positionGeneration, slots: [] as Array<SlotId | null> }
      this.castBatch = batch
      // The rows on screen ask as they render: one request for all of them (night/tabperf: a
      // chat opened with a GetCast per message, 22 on a page, each reading the cards again).
      setTimeout(() => {
        if (this.castBatch !== batch) return
        this.castBatch = null
        void this.readCasts(batch.forkId, batch.slots, batch.generation)
      }, 0)
    }
    this.castBatch.slots.push(slotId)
    return undefined
  }

  /** Positions waiting for their cast, asked for together. */
  private castBatch: {
    readonly forkId: ForkId | null
    readonly generation: number
    readonly slots: Array<SlotId | null>
  } | null = null

  private async readCasts(forkId: ForkId | null, slots: ReadonlyArray<SlotId | null>, generation: number) {
    const current = () => !this.disposed && this.view.forkId === forkId && this.positionGeneration === generation
    for (let start = 0; start < slots.length; start += 200) {
      if (!current()) return
      const page = slots.slice(start, start + 200)
      const result = await this.call((client) => client("GetCasts", { chatId: this.chatId, slotIds: page, forkId }))
      if (!current()) return
      page.forEach((slotId, i) => {
        const key = slotId ?? ""
        if (result.ok && result.value[i]) this.positionCasts.set(key, result.value[i])
        else this.positionCasts.delete(key)
      })
      for (const listener of this.positionListeners) listener()
    }
  }

  private forgetPositions() {
    this.positionGeneration++
    this.castBatch = null
    this.positionCasts.clear()
    for (const listener of this.positionListeners) listener()
  }

  /**
   * Bumped by every `Queue` event. A queue the server returned (a read, or a send's reply)
   * was taken before the events that arrived while it was in flight, so it's dropped when
   * one did: the event is newer, and an older snapshot could bring back a posted entry.
   */
  private queueEvents = 0

  private async queueSnapshot<A>(
    request: Promise<Outcome<A>>,
    queue: (value: A) => ReadonlyArray<QueuedMessage> | null
  ): Promise<Outcome<A>> {
    const seen = this.queueEvents
    const result = await request
    if (result.ok && !this.disposed && seen === this.queueEvents) {
      const next = queue(result.value)
      if (next !== null) this.update({ queue: next })
    }
    return result
  }

  private async refreshQueue() {
    await this.queueSnapshot(
      this.call((client) => client("ListQueued", { chatId: this.chatId })),
      (queue) => queue
    )
  }

  // --- Card text for macros at a message (`{{description}}` in a greeting), by card.

  private readonly cardTexts = new Map<string, CardFields | "loading">()

  /** The fields a card's macros read; undefined until read, then a `subscribePositions` change. */
  cardFields(entityId: EntityId): CardFields | undefined {
    const known = this.cardTexts.get(entityId)
    if (known !== undefined) return known === "loading" ? undefined : known
    this.cardTexts.set(entityId, "loading")
    void this.call((client) => client("GetCardForChat", { entityId })).then((result) => {
      if (this.disposed) return
      // A card in the bin or gone reads as empty fields, as in assembly.
      this.cardTexts.set(
        entityId,
        result.ok
          ? {
              description: result.value.description,
              personality: result.value.personality,
              scenario: result.value.scenario
            }
          : {}
      )
      for (const listener of this.positionListeners) listener()
    })
    return undefined
  }

  private report() {
    if (!PERF) return
    const { entries, older, newer, loading, error } = this.view
    perf.window = {
      loaded: entries.length,
      first: entries[0]?.slotId ?? "",
      older: older !== null,
      newer: newer !== null,
      paging: this.paging,
      loading,
      error: error ?? ""
    }
  }

  // --- The server

  call<A, E>(rpc: (client: Client) => Effect.Effect<A, E>): Promise<Outcome<A>> {
    return Effect.runPromiseExit(
      Effect.flatMap(Registry.getResult(this.registry, AppClient.runtime), (services) =>
        rpc(Context.get(services, AppClient))
      )
    ).then((exit) => {
      if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
      const error = describeCause(exit.cause)
      if (error.tag === "Unauthorized") this.registry.refresh(sessionAtom)
      return { ok: false, error }
    })
  }

  private chatsTimer: ReturnType<typeof setTimeout> | null = null
  private chatsInvalidate: (() => void) | null = null

  /** Has the lists of chats read again a second after the first change since they last were. */
  private chatsChanged(services: Context.Context<Reactivity.Reactivity>) {
    this.chatsInvalidate = () => {
      this.chatsTimer = null
      this.chatsInvalidate = null
      Context.get(services, Reactivity.Reactivity).invalidateUnsafe(["chats"])
    }
    this.chatsTimer ??= setTimeout(() => this.chatsInvalidate?.(), CHATS_REREAD_MS)
  }

  /**
   * Subscribes, and opens the chat on the first Hello: subscribing before reading means
   * no change can fall between the two (chatApi.ts).
   */
  start(anchor: SlotId | null) {
    this.disposed = false
    seeds.delete(this.chatId)
    for (const entry of this.view.entries) this.track(entry.version)
    this.hellos = 0
    const subscribe = Effect.flatMap(Registry.getResult(this.registry, AppClient.runtime), (services) =>
      Context.get(services, AppClient)("SubscribeChat", { chatId: this.chatId }).pipe(
        Stream.runForEach((batch) =>
          Effect.sync(() => {
            if (batch.some((event) => event._tag === "State" || event._tag === "Reload" || event._tag === "Hello")) {
              Context.get(
                services as unknown as Context.Context<Reactivity.Reactivity>,
                Reactivity.Reactivity
              ).invalidateUnsafe([`chat-notes:${this.chatId}`])
            }
            // The lists of chats (the left panel's, at 0.1 to 0.5 s a read at the owner's scale)
            // read again once the chat has changed, at most once a second, and not for the Hello
            // that opens it: the lists were just read, and opening a chat changes none of them.
            const opening = this.hellos === 0 && batch.every((event) => event._tag === "Hello")
            if (
              !opening &&
              batch.some((event) =>
                ["Hello", "Chat", "Slot", "Version", "State", "Reload", "Deleted"].includes(event._tag)
              )
            )
              this.chatsChanged(services as unknown as Context.Context<Reactivity.Reactivity>)
            this.receive(batch, anchor)
          })
        )
      )
    )
    this.subscription = Effect.runFork(
      subscribe.pipe(
        // A dropped socket ends the stream: subscribe again, and its Hello reloads.
        Effect.retry({ schedule: Schedule.spaced("1 second"), while: (error) => !this.notFound(error) }),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            if (!Cause.hasInterruptsOnly(cause)) this.update({ error: describeCause(cause).message, loading: false })
          })
        )
      )
    )
  }

  private notFound = (error: unknown) => error instanceof NotFound

  dispose() {
    this.disposed = true
    this.positionGeneration++
    this.castBatch = null
    // Text typed in a message editor and not saved yet goes to the server on the way out.
    for (const editor of this.editors.values()) void editor.save()
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.saveEditors)
    if (this.lcmTimer !== null) clearTimeout(this.lcmTimer)
    if (this.highlightTimer !== null) clearTimeout(this.highlightTimer)
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    if (this.subscription) Effect.runFork(Fiber.interrupt(this.subscription))
    for (const [id, unmount] of this.live) {
      this.registry.set(waitingCache(id), false)
      this.registry.set(liveText(id), null)
      this.registry.set(liveReasoning(id), null)
      this.registry.set(liveSections(id), null)
      unmount()
    }
    this.live.clear()
  }

  // --- Reading windows

  private async read(
    range: PathRange,
    limit = PAGE,
    forkId = this.view.forkId ?? this.requestedFork
  ): Promise<PathWindow | null> {
    const result = await this.call((client) =>
      client("ReadPath", { chatId: this.chatId, forkId, leafSlotId: null, range, limit })
    )
    if (result.ok) return result.value
    if (!this.disposed) this.update({ error: result.error.message, loading: false })
    return null
  }

  /**
   * Runs a read and applies what it returns. The server may answer it from before an
   * event that arrived meanwhile and was already applied: the reply would then undo it.
   * So the events received while reads are in flight are applied again once each lands;
   * applying one twice changes nothing (by row version).
   */
  private async reading(read: () => Promise<void>) {
    this.reads++
    try {
      await read()
    } finally {
      this.reads--
      const missed = this.missed
      if (this.reads === 0) this.missed = []
      if (!this.disposed) for (const event of missed) this.applyState(event)
    }
  }

  /**
   * Replaces the window: at the bottom, or around a slot; `reposition` scrolls to it.
   * `followCurrent` reads the chat's current fork rather than the one shown.
   */
  open(anchor: SlotId | null, limit = PAGE, reposition = true, followCurrent = false) {
    const generation = ++this.generation
    this.update({ loading: this.view.entries.length === 0 })
    return this.reading(async () => {
      const [window, chat] = await Promise.all([
        this.read(
          anchor === null ? { _tag: "Bottom" } : { _tag: "Around", slot: anchor },
          limit,
          followCurrent ? null : undefined
        ),
        this.call((client) => client("GetChat", { chatId: this.chatId }))
      ])
      if (window === null || this.disposed || generation !== this.generation) return
      const previousLeaf = this.view.leafSlotId
      this.update({
        chat: chat.ok ? chat.value : this.view.chat,
        forkId: window.forkId,
        leafSlotId: window.leafSlotId,
        entries: window.entries,
        older: window.older,
        newer: window.newer,
        follow: window.newer === null,
        opened: reposition ? this.view.opened + 1 : this.view.opened,
        loading: false,
        error: null
      })
      for (const entry of window.entries) this.track(entry.version)
      // update already read the cast for a moved tip.
      if (previousLeaf === window.leafSlotId) void this.refreshCast()
      // A leaf read starts the context read (update); a chat with no messages has none to change.
      if (window.leafSlotId === null) void this.refreshContext()
      void this.refreshQueue()
      void this.refreshEditors()
    })
  }

  // --- Message editors (messageDraft.ts): kept here, not in the rows, which unmount when
  // scrolled away; read from the server's drafts when the chat opens, so a reload opens them again.

  private readonly editors = new Map<MessageEditorKey, MessageDraft>()
  private readonly editSlots = new Map<VersionId, SlotId>()
  private readonly userId: string
  /** This browser's copies of the editors' text were sent (once, as the chat opens). */
  private editorsRestored = false
  private readonly editorListeners = new Set<() => void>()
  private readonly saveEditors = () => {
    for (const editor of this.editors.values()) void editor.save()
  }

  readonly subscribeEditors = (listener: () => void) => {
    this.editorListeners.add(listener)
    return () => {
      this.editorListeners.delete(listener)
    }
  }

  private queueEditorSnapshot: ReadonlyArray<MessageDraft> = []

  private editorsChanged() {
    this.queueEditorSnapshot = [...this.editors.values()].filter((editor) => editor.target._tag === "Queue")
    for (const listener of this.editorListeners) listener()
  }

  /** The open editor of a version's edit or of a version being written of a slot, if any. */
  editor(key: MessageEditorKey): MessageDraft | undefined {
    return this.editors.get(key)
  }

  readonly queueEditors = () => this.queueEditorSnapshot

  /** An edit stays on its slot when an import or another tab selects another version. */
  editForSlot(slotId: SlotId, versions: ReadonlyArray<Version>): MessageDraft | undefined {
    for (const editor of this.editors.values()) {
      if (editor.target._tag !== "Edit") continue
      const id = editor.target.versionId
      if (this.editSlots.get(id) === slotId || versions.some((version) => version.id === id)) return editor
    }
    return undefined
  }

  /** Remembers the slot of a restored edit once its source version was read. */
  bindEditor(editor: MessageDraft, slotId: SlotId) {
    if (editor.target._tag === "Edit" && this.editors.get(editorKey(editor.target)) === editor) {
      this.editSlots.set(editor.target.versionId, slotId)
    }
  }

  /** Opens an editor, or the one already open there, with its text. */
  openEditor(target: MessageDraftTarget, initial: string, slotId?: SlotId): MessageDraft {
    if (target._tag === "Edit" && slotId !== undefined) this.editSlots.set(target.versionId, slotId)
    const key = editorKey(target)
    const open = this.editors.get(key)
    if (open) return open
    const editor = new MessageDraft(this, this.userId, target, initial, null)
    this.editors.set(key, editor)
    this.editorsChanged()
    return editor
  }

  closeEditor(editor: MessageDraft) {
    const key = editorKey(editor.target)
    if (this.editors.get(key) !== editor) return
    this.editors.delete(key)
    if (editor.target._tag === "Edit") this.editSlots.delete(editor.target.versionId)
    this.editorsChanged()
  }

  private async refreshEditors() {
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.saveEditors)
      window.addEventListener("pagehide", this.saveEditors)
    }
    const result = await this.call((client) => client("MessageDrafts", { chatId: this.chatId }))
    if (!result.ok || this.disposed) return
    let changed = false
    for (const draft of result.value) {
      const target = targetOf(draft)
      if (target === null || this.editors.has(editorKey(target))) continue
      this.editors.set(editorKey(target), new MessageDraft(this, this.userId, target, draft.content, draft))
      changed = true
    }
    // Once the chat's drafts are read: text typed here that never reached the server goes
    // to it now, each editor opened again with it, a draft or not.
    const restore = !this.editorsRestored
    this.editorsRestored = true
    const copies = new Map<MessageEditorKey, { target: MessageDraftTarget; copies: Array<Copy> }>()
    if (restore)
      for (const copy of await copiesOf(this.userId, messageCopies(this.chatId))) {
        const save = pendingOf(copy)
        if (save?.kind !== "message") continue
        const key = editorKey(save.payload.target)
        const entry = copies.get(key) ?? { target: save.payload.target, copies: [] }
        entry.copies.push(copy)
        copies.set(key, entry)
      }
    if (this.disposed) return
    for (const [key, { target, copies: theirs }] of copies) {
      let editor = this.editors.get(key)
      if (editor === undefined) {
        editor = new MessageDraft(this, this.userId, target, "", null)
        this.editors.set(key, editor)
        changed = true
      }
      void editor.restore(theirs)
    }
    if (changed) this.editorsChanged()
  }

  /** What a version shows now: the text streamed so far while it's generating. */
  textOf(version: Version): string {
    return this.registry.get(liveText(version.id)) ?? version.content
  }

  async loadOlder() {
    const from = this.view.older
    if (from === null || this.paging || this.view.loading) return
    this.paging = true
    this.report()
    const generation = this.generation
    await this.reading(async () => {
      const window = await this.read({ _tag: "Older", from })
      this.paging = false
      this.report()
      if (window === null || this.disposed || generation !== this.generation || this.view.older !== from) return
      let entries = [...window.entries, ...this.view.entries]
      let newer = this.view.newer
      if (entries.length > MAX_LOADED) {
        entries = entries.slice(0, MAX_LOADED)
        newer = entries.at(-1)!.slotId
      }
      this.update({ entries, older: window.older, newer, follow: newer === null && this.view.follow })
      for (const entry of window.entries) this.track(entry.version)
    })
  }

  async loadNewer() {
    const after = this.view.newer
    if (after === null || this.paging || this.view.loading) return
    this.paging = true
    this.report()
    const generation = this.generation
    await this.reading(async () => {
      const window = await this.read({ _tag: "Newer", after })
      this.paging = false
      this.report()
      if (window === null || this.disposed || generation !== this.generation || this.view.newer !== after) return
      let entries = [...this.view.entries, ...window.entries]
      let older = this.view.older
      if (entries.length > MAX_LOADED) {
        entries = entries.slice(entries.length - MAX_LOADED)
        older = entries[0]!.parentSlotId
      }
      // A page read on the way down never scrolls to the end by itself.
      this.update({ entries, older, newer: window.newer, follow: false })
      for (const entry of window.entries) this.track(entry.version)
    })
  }

  /** Shows another fork (null: the chat's current one), at a message or at its bottom. */
  showFork(fork: ForkId | null, anchor: SlotId | null) {
    this.requestedFork = fork
    this.update({ forkId: fork, leafSlotId: null, entries: [], loading: true })
    // Position subscribers can read synchronously when notified: they must see the new fork.
    this.forgetPositions()
    void this.open(anchor)
  }

  /** At the bottom of the whole path: new messages follow again. */
  followAtBottom() {
    if (this.view.newer === null && !this.view.follow) this.update({ follow: true })
  }

  // --- Events

  private receive(batch: ReadonlyArray<ChatEvent>, anchor: SlotId | null) {
    if (PERF) perf.batches++
    for (const event of batch) {
      if (event._tag === "Delta") {
        if (PERF) perf.deltas++
        const list = this.pending.get(event.versionId)
        if (list) list.push(event)
        else this.pending.set(event.versionId, [event])
        continue
      }
      if (event._tag === "Reasoning" || event._tag === "Section") {
        const pending = event._tag === "Reasoning" ? this.pendingReasoning : this.pendingSections
        const list = pending.get(event.versionId)
        if (list) list.push(event)
        else pending.set(event.versionId, [event])
        continue
      }
      // Anything else applies after the text that came before it.
      this.flush()
      this.apply(event, anchor)
    }
    if (
      (this.pending.size > 0 || this.pendingReasoning.size > 0 || this.pendingSections.size > 0) &&
      this.frame === null
    ) {
      this.frame = requestAnimationFrame(() => {
        this.frame = null
        this.flush()
      })
    }
  }

  /** Applies the deltas received so far: one atom update per version. */
  private flush() {
    for (const [pending, atom, stored] of [
      [this.pendingReasoning, liveReasoning, (id: VersionId) => this.storedReasoning(id)],
      [this.pendingSections, liveSections, (id: VersionId) => this.storedSections(id)]
    ] as const) {
      if (pending.size === 0) continue
      Atom.batch(() => {
        for (const [id, deltas] of pending) {
          let text = this.registry.get(atom(id)) ?? stored(id)
          for (const { offset, text: added, replace } of deltas) {
            if (offset <= text.length && (replace || offset + added.length > text.length))
              text = text.slice(0, offset) + added
          }
          this.setLiveSide(atom, id, text)
        }
      })
      pending.clear()
    }
    if (this.pending.size === 0) return
    Atom.batch(() => {
      for (const [id, deltas] of this.pending) {
        let text = this.registry.get(liveText(id)) ?? ""
        // A delta adds text past what's shown; a `replace` one (scripts rewrote the text so far)
        // is the text from its offset on, even if shorter.
        for (const { offset, text: added, replace } of deltas) {
          if (offset > text.length) {
            if (PERF) perf.gaps++
          } else if (replace || offset + added.length > text.length) text = text.slice(0, offset) + added
        }
        this.setLive(id, text)
        if (PERF) {
          perf.rowUpdates++
          if (mountedBodies.has(id)) perf.shownUpdates++
        }
      }
    })
    this.pending.clear()
  }

  private apply(
    event: Exclude<ChatEvent, { readonly _tag: "Delta" | "Reasoning" | "Section" }>,
    anchor: SlotId | null,
    initialContext = false
  ) {
    switch (event._tag) {
      case "Hello": {
        for (const { versionId, text, waitingCache: waiting, reasoning, sections } of event.live) {
          this.registry.set(waitingCache(versionId), waiting ?? false)
          if (text.length >= (this.registry.get(liveText(versionId)) ?? "").length) this.setLive(versionId, text)
          if (reasoning && reasoning.length >= (this.registry.get(liveReasoning(versionId)) ?? "").length)
            this.setLiveSide(liveReasoning, versionId, reasoning)
          if (sections && sections.length >= (this.registry.get(liveSections(versionId)) ?? "").length)
            this.setLiveSide(liveSections, versionId, sections)
        }
        // The first Hello opens the chat. Another means the socket reconnected, and
        // anything may have changed meanwhile.
        if (this.hellos++ === 0) return void this.open(anchor)
        // Anything that stopped generating while the socket was down lost its Version
        // event: its live text would hide the saved one.
        const live = new Set(event.live.map((l) => l.versionId))
        for (const id of [...this.live.keys()]) if (!live.has(id)) this.endLive(id)
        for (const listener of this.choiceListeners) listener(null)
        this.reload()
        return
      }
      case "Version":
        if (event.version.writer === "model" && event.version.status === "complete") refreshTokenCounts()
        // Another fork's flags or copy aren't this one's (spec/FORK-INDEPENDENCE-DELTA.md §2.2).
        if (event.forkId !== undefined && this.view.forkId !== null && event.forkId !== this.view.forkId) return
      // falls through
      case "Slot":
        this.update({ pathRevision: this.view.pathRevision + 1 })
        if (this.reads > 0) this.missed.push(event)
        return this.applyState(event)
      case "Chat":
        if (this.reads > 0) this.missed.push(event)
        return this.applyState(event)
      case "Reload":
        return this.reload()
      case "Deleted":
        return this.update({ deleted: true })
      case "Queue":
        this.queueEvents++
        return this.update({ queue: event.queue })
      case "State":
        this.forgetPositions()
        this.scheduleLcm()
        chatStateChanged(this.chatId)
        return void this.refreshCast()
      case "Lcm":
        return this.scheduleLcm()
      case "ComposerChoice":
        for (const listener of this.choiceListeners) listener(event.choice)
        return
      case "WaitingCache":
        if (!this.live.has(event.versionId)) this.setLive(event.versionId, "")
        this.registry.set(waitingCache(event.versionId), event.waiting)
        return
      case "Cache": {
        for (const listener of this.contextListeners) listener(initialContext)
        // An edit, a swipe, a delete or a hide can make a summary stale; the estimate follows
        // every such change, so the layer is read again with it.
        if (!initialContext || this.lcmReads === 0) this.scheduleLcm()
        if (event.leafSlotId !== this.view.leafSlotId || (event.forkId != null && event.forkId !== this.view.forkId)) {
          void this.refreshContext()
          return
        }
        this.contextReads++
        // The same estimate again (another tab subscribed) changes nothing on screen.
        const history = {
          assemblyError: event.assemblyError ?? null,
          assemblyErrorReason: event.assemblyErrorReason ?? null,
          leafSlotId: event.leafSlotId,
          historyStart: event.historyStart,
          summarizedThrough: event.summarizedThrough,
          ...(event.presetContext === undefined ? {} : { presetContext: event.presetContext }),
          ...(event.budget === undefined ? {} : { budget: event.budget }),
          ...(event.preset === undefined ? {} : { preset: event.preset }),
          ...(event.model === undefined ? {} : { model: event.model }),
          ...(event.images === undefined ? {} : { images: event.images }),
          ...(event.imageTokens === undefined ? {} : { imageTokens: event.imageTokens })
        }
        if (
          JSON.stringify(event.warmth) === JSON.stringify(this.view.cache) &&
          JSON.stringify(history) === JSON.stringify(this.view.history)
        )
          return
        return this.update({ cache: event.warmth, history })
      }
    }
  }

  /** Applies a change to loaded state; applying it again, or after a newer one, changes nothing. */
  private applyState(event: Replayable) {
    switch (event._tag) {
      case "Slot":
        return void this.applySlot(event.entry)
      case "Version":
        return this.applyVersion(event.version)
      case "Chat":
        if (this.view.chat !== null && this.view.chat.rowVersion > event.chat.rowVersion) return
        return this.update({ chat: event.chat })
    }
  }

  /** Reads the loaded range again, as far as one read goes, keeping the same slots in view. */
  private reload() {
    this.update({ pathRevision: this.view.pathRevision + 1 })
    this.scheduleLcm()
    const { entries, newer } = this.view
    const limit = Math.min(MAX_LOADED, Math.max(PAGE, entries.length))
    // A deletion can replace the current fork. Follow it only if this tab was showing it;
    // tabs explicitly showing another fork keep their own.
    const followCurrent = this.requestedFork === null && this.view.forkId === this.view.chat?.currentForkId
    if (newer === null || entries.length === 0) return void this.open(null, limit, entries.length === 0, followCurrent)
    void this.open(entries[Math.floor(entries.length / 2)]!.slotId, limit, false, followCurrent)
  }

  /**
   * A slot added or changed; returns whether it's in the window. A new one joins when it
   * continues the loaded bottom of the path.
   */
  private applySlot(entry: PathEntry): boolean {
    const { entries } = this.view
    const index = entries.findIndex((e) => e.slotId === entry.slotId)
    // Another fork's choices (its selection, its row version) aren't this one's: a slot shown
    // here is read again as this fork shows it.
    if (
      entry.shownForkId !== undefined &&
      this.view.forkId !== null &&
      entry.shownForkId !== this.view.forkId &&
      index >= 0
    ) {
      void this.refreshSlot(entry.slotId)
      return true
    }
    const known = this.view.branchNames.get(entry.slotId)
    if (
      (entry.branchCount > 1 || entry.branchName !== undefined || known !== undefined) &&
      (known === undefined || known.rowVersion < entry.rowVersion)
    ) {
      this.update({
        branchNames: new Map(this.view.branchNames).set(entry.slotId, {
          name: entry.branchName,
          rowVersion: entry.rowVersion
        })
      })
    }
    if (index >= 0) {
      const current = entries[index]!
      if (current.rowVersion > entry.rowVersion) return true
      const next = entries.slice()
      // A finished version may arrive before the slot event that started it.
      const finished = current.version.id === entry.version.id && current.version.status !== "generating"
      const updated = finished && entry.version.status === "generating" ? withInContext(entry, current.version) : entry
      // Where it is in the window is the window's: an event's position is the one it was sent with.
      const stored = withPosition(updated, current.position)
      next[index] = stored
      this.update({ entries: next })
      this.track(stored.version)
      return true
    }
    // A message another fork appended at the same tip isn't this fork's.
    const otherFork = entry.forkId !== undefined && this.view.forkId !== null && entry.forkId !== this.view.forkId
    // A message inserted in this fork goes in place, by its position (spec/MESSAGE-INSERT.md §2.3).
    if (entry.inserted === true) {
      if (entry.shownForkId !== undefined ? entry.shownForkId !== this.view.forkId : otherFork) return false
      // Single-slot updates have no position. An unknown insertion must never become the
      // structural tip through the append path below.
      if (entry.position === undefined) {
        this.reload()
        return false
      }
      return this.placeInserted(entry)
    }
    // An append goes below the fork's tip, which the window ends with, or which an inserted
    // message shown last follows (its anchor; a deleted tip whose inserted messages stay shown).
    const last = entries.at(-1)
    const continues =
      entry.parentSlotId === (last?.slotId ?? null) ||
      (entry.parentSlotId === this.view.leafSlotId && last?.inserted === true)
    if (this.view.newer !== null || otherFork || !continues) {
      // A new alternate of a message shown: it counts one more branch (DESIGN §3.2).
      if (entries.some((e) => e.parentSlotId === entry.parentSlotId && e.branchCount < entry.branchCount)) {
        this.update({
          entries: entries.map((e) =>
            e.parentSlotId === entry.parentSlotId && e.laneId === entry.laneId && e.branchCount < entry.branchCount
              ? ({ ...e, branchCount: entry.branchCount } as PathEntry)
              : e
          )
        })
      }
      // The path's leaf moves on below the window too.
      if (
        this.view.newer !== null &&
        !otherFork &&
        entry.parentSlotId !== null &&
        entry.parentSlotId === this.view.leafSlotId
      ) {
        this.update({ leafSlotId: entry.slotId })
      }
      return false
    }
    // Numbered after the last shown, once the window numbers by position.
    const appended = last?.position === undefined ? entry : withPosition(entry, positionOf(last) + 1)
    let next = [...entries, appended]
    let older = this.view.older
    if (next.length > MAX_LOADED) {
      next = next.slice(next.length - MAX_LOADED)
      older = next[0]!.parentSlotId
    }
    this.update({ entries: next, older, leafSlotId: entry.slotId })
    this.track(entry.version)
    return true
  }

  /**
   * An inserted message, placed directly below its anchor: it's the newest of the anchor's gap,
   * so it comes before whatever was inserted there before. Everything after it moves down one
   * position. With an unknown anchor or a newer sibling already shown, the server re-reads
   * the window instead. Returns whether it was placed in the window immediately.
   */
  private placeInserted(entry: PathEntry): boolean {
    const { entries } = this.view
    const shift = (list: ReadonlyArray<PathEntry>) => list.map((e) => withPosition(e, positionOf(e) + 1))
    const at =
      entry.parentSlotId === null
        ? this.view.older === null
          ? 0
          : -1
        : entries.findIndex((e) => e.slotId === entry.parentSlotId) + 1 || -1
    const newerSibling = entries.some(
      (e) => e.inserted === true && e.parentSlotId === entry.parentSlotId && e.slotId > entry.slotId
    )
    if (at < 0 || newerSibling) {
      // Reader replies (and generation starts) can publish out of commit order. The event's
      // position was computed at commit time, so neither it nor arrival order can place a
      // delayed sibling/child or renumber an off-window insertion reliably. Read the window.
      this.reload()
      return false
    }
    const placed = withPosition(entry, at === 0 ? 0 : positionOf(entries[at - 1]!) + 1)
    this.update({ entries: [...entries.slice(0, at), placed, ...shift(entries.slice(at))] })
    this.track(entry.version)
    return true
  }

  /**
   * A message this tab added at the leaf. When the window doesn't reach the leaf (opened
   * at an older message), the chat opens at the bottom, where the message is.
   */
  private appended(entry: PathEntry, chat: Chat) {
    this.update({ chat })
    this.followAtBottom()
    if (this.applySlot(entry)) return
    // The fork it went to is the current one now.
    this.requestedFork = null
    this.update({ forkId: chat.currentForkId, leafSlotId: entry.slotId })
    void this.open(null)
  }

  private applyVersion(version: Version) {
    for (const listener of this.versionListeners) listener(version)
    if (version.status !== "generating") this.endLive(version.id)
    const { entries } = this.view
    const index = entries.findIndex((e) => e.version.id === version.id)
    if (index < 0) return
    const current = entries[index]!.version
    // Already newer: amended since, or finished where this says generating.
    if (current.rowVersion > version.rowVersion) return
    if (current.status !== "generating" && version.status === "generating") return
    const next = entries.slice()
    next[index] = withInContext(entries[index]!, version)
    this.update({ entries: next })
  }

  /** Keeps a generating version's text alive while it streams, shown or not. */
  private track(version: Version) {
    if (version.status !== "generating" || this.live.has(version.id)) return
    const known = this.registry.get(liveText(version.id))
    this.live.set(version.id, this.mountLive(version.id))
    if (known === null) this.registry.set(liveText(version.id), version.content)
    if (this.registry.get(liveReasoning(version.id)) === null)
      this.registry.set(liveReasoning(version.id), version.reasoning ?? "")
    if (this.registry.get(liveSections(version.id)) === null)
      this.registry.set(liveSections(version.id), sectionsDisplay(version.replySections))
  }

  private mountLive(id: VersionId) {
    const text = this.registry.mount(liveText(id))
    const reasoning = this.registry.mount(liveReasoning(id))
    const sections = this.registry.mount(liveSections(id))
    const waiting = this.registry.mount(waitingCache(id))
    return () => {
      text()
      reasoning()
      sections()
      waiting()
    }
  }

  private setLive(id: VersionId, text: string) {
    if (!this.live.has(id)) this.live.set(id, this.mountLive(id))
    this.registry.set(liveText(id), text)
  }

  /** A loaded version's saved reasoning: where a continuation's streamed reasoning goes on from. */
  private storedReasoning(id: VersionId) {
    return this.view.entries.find((e) => e.version.id === id)?.version.reasoning ?? ""
  }

  /** A continuation's saved section text, where its streamed sections go on from. */
  private storedSections(id: VersionId) {
    return sectionsDisplay(this.view.entries.find((e) => e.version.id === id)?.version.replySections)
  }

  private setLiveSide(atom: typeof liveReasoning, id: VersionId, text: string) {
    if (!this.live.has(id)) this.live.set(id, this.mountLive(id))
    this.registry.set(atom(id), text)
  }

  private endLive(id: VersionId) {
    this.pending.delete(id)
    this.pendingReasoning.delete(id)
    this.pendingSections.delete(id)
    this.registry.set(waitingCache(id), false)
    this.registry.set(liveText(id), null)
    this.registry.set(liveReasoning(id), null)
    this.registry.set(liveSections(id), null)
    this.live.get(id)?.()
    this.live.delete(id)
  }

  // --- Writes. Each applies the server's reply at once; its event, arriving too, changes nothing.

  /**
   * The user's message at the leaf of the fork shown (its composer's), as `speaker` (Send
   * as X), which makes that fork current, then a reply to it by `replySpeaker`, unless
   * `reply` is false. Onto a reply still being written, it's queued and the server posts it,
   * with its reply, when that one ends (DESIGN §2.2). `sent` says whether the message went,
   * and `draft` is the composer draft as the send left it.
   */
  async send(
    content: string,
    speaker: EntityId | null = null,
    replySpeaker: EntityId | null = null,
    /** The composer draft the text came from, which the send commits (DESIGN §6.2). */
    composer?: ComposerSource,
    /** False when no one may reply (every character muted, DESIGN §3.5): the message is only posted. */
    reply = true,
    images?: import("@rp/shared/chat.ts").MessageImages,
    imageDraftIds?: readonly string[],
    /** Who replies after `replySpeaker`, in turn: the rest of the round (DESIGN §2.3). */
    round: ReadonlyArray<EntityId> = []
  ): Promise<{
    readonly sent: boolean
    readonly outcome: Outcome<unknown>
    readonly draft: SendResult["draft"]
    readonly recovered: number
  }> {
    // What you see is what's sent: typing in open editors reaches the server first.
    if (reply) await beforeReply()
    const result = await this.queueSnapshot(
      this.call((client) =>
        client("SendMessage", {
          chatId: this.chatId,
          forkId: composer?.fork ?? this.view.forkId,
          parentSlotId: this.view.leafSlotId,
          branch: false,
          content,
          ...(images === undefined ? {} : { images }),
          ...(imageDraftIds === undefined ? {} : { imageDraftIds }),
          speakerEntityId: speaker,
          // If it's queued, the server asks for the reply when it posts, from the same speaker.
          replySpeakerEntityId: replySpeaker,
          // Queued with no one to reply, it posts alone, as it does at once.
          ...(reply ? {} : { reply: false }),
          ...(reply && round.length > 0 ? { round } : {}),
          ...(composer === undefined ? {} : { composer: commitOf(composer) })
        })
      ),
      (value) => (value._tag === "Queued" ? value.queue : null)
    )
    if (!result.ok) {
      if (result.error.tag === "LeafMoved") this.reload()
      return { sent: false, outcome: result, draft: null, recovered: 0 }
    }
    const { draft, recovered } = result.value
    if (result.value._tag === "Queued") return { sent: true, outcome: result, draft, recovered }
    this.appended(result.value.entry, result.value.chat)
    if (!reply) return { sent: true, outcome: result, draft, recovered }
    return {
      sent: true,
      outcome: await this.generate(result.value.entry.slotId, replySpeaker, "", undefined, round),
      draft,
      recovered
    }
  }

  /**
   * A model reply at the leaf, or under the message just sent, as `speaker` (Generate X),
   * with a one-turn `direction`. Onto a reply still being written, it's queued.
   */
  async generate(
    parentSlotId = this.view.leafSlotId,
    speaker: EntityId | null = null,
    direction = "",
    composer?: ComposerSource,
    /** Who replies after this one, in turn: the rest of the round (DESIGN §2.3). */
    round: ReadonlyArray<EntityId> = []
  ): Promise<Outcome<SendResult>> {
    await beforeReply()
    const result = await this.queueSnapshot(
      this.call((client) =>
        client("Generate", {
          chatId: this.chatId,
          forkId: composer?.fork ?? this.view.forkId,
          parentSlotId,
          branch: false,
          speakerEntityId: speaker,
          ...(direction.trim() === "" ? {} : { direction }),
          ...(round.length > 0 ? { round } : {}),
          ...(composer === undefined ? {} : { composer: commitOf(composer) })
        })
      ),
      (value) => (value._tag === "Queued" ? value.queue : null)
    )
    if (result.ok) {
      if (result.value._tag === "Posted") this.appended(result.value.entry, result.value.chat)
    } else if (result.error.tag === "LeafMoved") this.reload()
    return result
  }

  /**
   * The shown fork's round (DESIGN §2.3): `continue` goes on with a stopped one, its next reply
   * at the tip; `end` drops what's left of it. The posted reply arrives as the queue's do.
   */
  async round(action: "continue" | "end"): Promise<Outcome<unknown>> {
    if (action === "continue") await beforeReply()
    return this.queueSnapshot(
      this.call((client) => client("Round", { chatId: this.chatId, forkId: this.view.forkId, action })),
      (queue) => queue
    )
  }

  /** Changes who's in the chat, or a setting, from the leaf shown on (DESIGN §3.4). */
  async changeCast(change: CastChange): Promise<Outcome<Cast>> {
    const { forkId, leafSlotId } = this.view
    const result = await this.call((client) =>
      client("ChangeCast", { chatId: this.chatId, slotId: leafSlotId, forkId, change })
    )
    // The save's snapshot may predate another pin. Read the current cast after it commits.
    if (result.ok && !this.disposed && forkId === this.view.forkId && leafSlotId === this.view.leafSlotId) {
      this.forgetPositions()
      await this.refreshCast()
    }
    return result
  }

  /**
   * Saves a queued message's new text over the version the editor started from: if another
   * tab changed it since, that's StaleWrite, and nothing is overwritten.
   */
  async editQueued(
    queued: QueuedMessage,
    content: string,
    from: { readonly rowVersion: number; readonly speakerEntityId: EntityId | null },
    draft?: { readonly draftId: string; readonly session: number } | null
  ): Promise<Outcome<QueuedMessage>> {
    return this.call((client) =>
      client("EditQueued", {
        queuedId: queued.id,
        ...(draft == null ? {} : { draft }),
        content,
        speakerEntityId: from.speakerEntityId,
        expectedRowVersion: from.rowVersion
      })
    )
  }

  /** Every card the user can speak as or add (DESIGN §2.2). */
  listCards() {
    return this.call((client) => client("ListCards", undefined))
  }

  /** Takes a queued entry back; its text is returned for the composer. */
  async withdrawQueued(queued: QueuedMessage): Promise<Outcome<QueuedMessage>> {
    const result = await this.call((client) =>
      client("WithdrawQueued", { queuedId: queued.id, expectedRowVersion: queued.rowVersion })
    )
    if (result.ok) this.update({ queue: this.view.queue.filter((q) => q.id !== queued.id) })
    return result
  }

  /** Whether to say, once for this preset, that its anti-impersonation rules may need a condition. */
  impersonationNotice() {
    return this.call((client) => client("ImpersonationNotice", {}))
  }

  /** Where guidance comes from; nothing here until a composer says (DESIGN §2.2). */
  private guidanceText: (request: GuidanceRequest) => string | undefined = () => undefined

  /**
   * The composer says what guidance a new version or Continue of a slot is asked with (DESIGN
   * §2.2, guidance on swipes), read as each is asked for: a text (empty for none), or
   * undefined for a new version that reuses the guidance of the version it re-rolls. Returns
   * the undo.
   */
  provideGuidance(read: (request: GuidanceRequest) => string | undefined): () => void {
    this.guidanceText = read
    return () => {
      if (this.guidanceText === read) this.guidanceText = () => undefined
    }
  }

  /** The direction asked for now: undefined to reuse the re-rolled version's, "" for none. */
  guidance(request: GuidanceRequest): string | undefined {
    const text = this.guidanceText(request)
    return text === undefined || text.trim() !== "" ? text : ""
  }

  /**
   * A swipe using the currently selected model.
   * It's written with the guidance of the version it re-rolls, unless the composer gives
   * this slot's guidance explicitly (the guidance editor's box, guidanceEdit.tsx).
   */
  async regenerate(entry: PathEntry): Promise<Outcome<unknown>> {
    await beforeReply()
    const direction = this.guidance({ slotId: entry.slotId, kind: "version" })
    return this.slotWrite(entry.slotId, (client) =>
      client("Regenerate", {
        slotId: entry.slotId,
        forkId: this.view.forkId,
        expectedRowVersion: entry.rowVersion,
        ...(direction === undefined ? {} : { direction })
      })
    )
  }

  /**
   * Continue (ST's): a new version that starts as this one's text and streams on from its
   * end, sent as the start of the reply to models that take one (DESIGN §7.5) and as the
   * model's own last message to others (owner, 2026-10-31), with the composer's guidance as
   * its direction.
   */
  async continueVersion(entry: PathEntry, useComposerGuidance = true): Promise<Outcome<unknown>> {
    await beforeReply()
    const direction = useComposerGuidance ? (this.guidance({ slotId: entry.slotId, kind: "continue" }) ?? "") : ""
    return this.slotWrite(entry.slotId, (client) =>
      client("ContinueVersion", {
        versionId: entry.version.id,
        forkId: this.view.forkId,
        expectedRowVersion: entry.rowVersion,
        ...(direction ? { direction } : {})
      })
    )
  }

  /** "Show as reply text": the reply's leading sections back in its text, as a new version (spec/REPLY-SECTIONS.md). */
  async showSectionsAsText(entry: PathEntry): Promise<Outcome<unknown>> {
    return this.slotWrite(entry.slotId, (client) =>
      client("ShowSectionsAsText", {
        versionId: entry.version.id,
        forkId: this.view.forkId,
        expectedRowVersion: entry.rowVersion
      })
    )
  }

  /**
   * Shows another version at once, in this fork only, and puts the slot back as it was if
   * the server refuses.
   */
  async select(entry: PathEntry, version: Version): Promise<Outcome<unknown>> {
    this.applySlot(withInContext(entry, version))
    const result = await this.slotWrite(entry.slotId, (client) =>
      client("SelectVersion", {
        slotId: entry.slotId,
        versionId: version.id,
        forkId: this.view.forkId,
        expectedVersionId: entry.version.id
      })
    )
    if (!result.ok && result.error.tag !== "StaleWrite") this.applySlot(entry)
    return result
  }

  /** Hides the message from the model, or shows it to the model again (ST's ghost toggle). */
  setHidden(entry: PathEntry, hidden: boolean): Promise<Outcome<PathEntry>> {
    return this.slotWrite(entry.slotId, (client) =>
      client("SetMessageHidden", { slotId: entry.slotId, forkId: this.view.forkId, hidden })
    )
  }

  /** Takes an image of the message's version out of the context in the fork shown, or puts it back. */
  setImageExcluded(entry: PathEntry, mediaId: string, excluded: boolean): Promise<Outcome<PathEntry>> {
    return this.slotWrite(entry.slotId, (client) =>
      client("SetImageExcluded", { versionId: entry.version.id, mediaId, forkId: this.view.forkId, excluded })
    )
  }

  /** A finished version the user wrote changes in place; anything else gets a new version. */
  async edit(
    entry: PathEntry,
    content: string,
    draft: DraftCommit | null = null,
    images?: import("@rp/shared/chat.ts").MessageImages
  ): Promise<Outcome<unknown>> {
    const { version } = entry
    const commit = { ...(draft === null ? {} : { draft }), ...(images === undefined ? {} : { images }) }
    if (version.writer === "human" && version.status !== "generating") {
      const result = await this.call((client) =>
        client("AmendVersion", {
          versionId: version.id,
          forkId: this.view.forkId,
          content,
          expectedRowVersion: version.rowVersion,
          ...commit
        })
      )
      // Another fork shows the version too: this fork shows a copy in its place now.
      if (result.ok && result.value.id !== version.id) void this.refreshSlot(entry.slotId)
      else if (result.ok) this.applyVersion(result.value)
      else if (result.error.tag === "StaleWrite") void this.refreshSlot(entry.slotId)
      return result
    }
    return this.slotWrite(entry.slotId, (client) =>
      client("EditVersion", {
        slotId: entry.slotId,
        forkId: this.view.forkId,
        sourceVersionId: version.id,
        content,
        expectedRowVersion: entry.rowVersion,
        ...commit
      })
    )
  }

  /**
   * Puts the text from before regex scripts rewrote the version back, as a new selected
   * version of the message (as an edit is), which no script rewrites.
   */
  restoreRawText(entry: PathEntry): Promise<Outcome<PathEntry>> {
    return this.slotWrite(entry.slotId, (client) =>
      client("RestoreRawText", {
        slotId: entry.slotId,
        forkId: this.view.forkId,
        versionId: entry.version.id,
        expectedRowVersion: entry.rowVersion
      })
    )
  }

  /** "Write your own version" (DESIGN §3.1): a new version of the user's, selected. */
  writeVersion(
    entry: PathEntry,
    content: string,
    draft: DraftCommit | null = null,
    images?: import("@rp/shared/chat.ts").MessageImages
  ): Promise<Outcome<unknown>> {
    return this.slotWrite(entry.slotId, (client) =>
      client("WriteVersion", {
        slotId: entry.slotId,
        forkId: this.view.forkId,
        content,
        expectedRowVersion: entry.rowVersion,
        ...(draft === null ? {} : { draft }),
        ...(images === undefined ? {} : { images })
      })
    )
  }

  async stop(versionId: VersionId): Promise<Outcome<unknown>> {
    const result = await this.call((client) => client("StopGeneration", { versionId }))
    if (result.ok) this.applyVersion(result.value)
    return result
  }

  /**
   * Inserts a message directly below `anchor` (null: above the first message) in the fork shown
   * (spec/MESSAGE-INSERT.md §4): written, generated at that point, or a copy of the version shown
   * there. It shows in place, briefly highlighted, and the messages after it renumber.
   */
  async insertMessage(anchor: PathEntry | null, body: InsertBody): Promise<Outcome<InsertedMessage>> {
    const forkId = this.view.forkId ?? this.view.chat?.currentForkId ?? null
    if (forkId === null)
      return { ok: false, error: { tag: "NotFound", message: "The chat isn't open yet.", problems: [], reason: null } }
    if (body._tag === "Generate") await beforeReply()
    const result = await this.call((client) =>
      client("InsertMessage", {
        chatId: this.chatId,
        forkId,
        anchor: anchor?.slotId ?? null,
        expectedRowVersion: anchor?.rowVersion ?? 0,
        body
      })
    )
    if (result.ok) {
      this.update({ chat: result.value.chat })
      this.applySlot(result.value.entry)
      this.highlightSlot(result.value.entry.slotId)
    } else if (result.error.tag === "StaleWrite") this.reload()
    return result
  }

  private highlightTimer: ReturnType<typeof setTimeout> | null = null

  /** Highlights a message for a moment (an insertion, where it went). */
  highlightSlot(slotId: SlotId) {
    if (this.highlightTimer !== null) clearTimeout(this.highlightTimer)
    this.update({ highlight: slotId })
    this.highlightTimer = setTimeout(() => {
      this.highlightTimer = null
      if (!this.disposed && this.view.highlight === slotId) this.update({ highlight: null })
    }, 2500)
  }

  /**
   * Undoes an insertion (spec §4.3): the message to the bin in this fork, as Delete would, so it
   * can be restored or purged there. A generation still running into it is stopped first.
   */
  async undoInsert(slotId: SlotId, forkId: ForkId | null = this.view.forkId): Promise<Outcome<unknown>> {
    const shown = this.view.entries.find((e) => e.slotId === slotId)
    if (this.view.forkId === forkId && shown?.version.status === "generating") await this.stop(shown.version.id)
    return this.call((client) => client("DeleteMessage", { slotId, forkId }))
  }

  /** Deletes the message in the fork shown only: another fork that has it keeps it. */
  deleteMessage(slotId: SlotId) {
    return this.call((client) => client("DeleteMessage", { slotId, forkId: this.view.forkId }))
  }

  /** Deletes the swipe in the fork shown only. */
  deleteVersion(versionId: VersionId) {
    return this.call((client) => client("DeleteVersion", { versionId, forkId: this.view.forkId }))
  }

  /** Stars a version or hides it from the arrows (the version picker), or undoes either. */
  async setVersionFlags(
    version: Version,
    flags: { readonly starred?: boolean; readonly hidden?: boolean }
  ): Promise<Outcome<Version>> {
    const result = await this.call((client) =>
      client("SetVersionFlags", { versionId: version.id, forkId: this.view.forkId, ...flags })
    )
    if (result.ok) this.applyVersion(result.value)
    return result
  }

  /** Deletes the fork to the bin: only that fork goes, and forks made from it keep their history. */
  async deleteFork(forkId: ForkId) {
    const result = await this.call((client) => client("DeleteFork", { forkId }))
    // The fork shown may have gone with it. Follow the chat's current fork, fencing every
    // earlier window read.
    if (result.ok) this.showFork(null, null)
    return result
  }

  /** The alternates where `slotId` is one, with their names. */
  listBranches(slotId: SlotId) {
    return this.call((client) => client("ListBranches", { slotId, forkId: this.view.forkId }))
  }

  /**
   * Names the fork that `entry` starts; that message, which shows the name among its
   * alternates, is read again.
   */
  async nameFork(entry: PathEntry, name: string): Promise<Outcome<Fork>> {
    const forkId = entry.startsForkId
    if (forkId === undefined)
      return {
        ok: false,
        error: { tag: "NotFound", message: "That message starts no fork.", problems: [], reason: null }
      }
    const result = await this.call((client) => client("NameFork", { forkId, name }))
    if (result.ok) await this.refreshSlot(entry.slotId)
    return result
  }

  /** Names the chat; the header shows it at once, other tabs on the `Chat` event, lists read again. */
  async rename(name: string): Promise<Outcome<Chat>> {
    const result = await this.call((client) => client("RenameChat", { chatId: this.chatId, name }))
    if (result.ok) {
      this.applyState({ _tag: "Chat", chat: result.value })
      this.invalidate(["chats"])
    }
    return result
  }

  /** Names the group the chat is in: all its chats, this one included. */
  async renameGroup(name: string) {
    const result = await this.call((client) => client("RenameGroup", { chatId: this.chatId, name }))
    if (result.ok) {
      const own = result.value.chats.find((chat) => chat.id === this.chatId)
      if (own) this.applyState({ _tag: "Chat", chat: own })
      this.invalidate(["chats"])
    }
    return result
  }

  /** Has the queries with these reactivity keys (the chat list, the home grid) read again. */
  private invalidate(keys: ReadonlyArray<string>) {
    void Effect.runPromise(
      Effect.map(Registry.getResult(this.registry, AppClient.runtime), (services) =>
        Context.get(
          services as unknown as Context.Context<Reactivity.Reactivity>,
          Reactivity.Reactivity
        ).invalidateUnsafe(keys)
      )
    )
  }

  listVersions(slotId: SlotId) {
    return this.call((client) => client("ListVersions", { slotId, forkId: this.view.forkId }))
  }

  /** A write that returns the slot after it. A stale one reads the slot again. */
  private async slotWrite<E>(
    slotId: SlotId,
    rpc: (client: Client) => Effect.Effect<PathEntry, E>
  ): Promise<Outcome<PathEntry>> {
    const result = await this.call(rpc)
    if (result.ok) this.applySlot(result.value)
    else if (result.error.tag === "StaleWrite") void this.refreshSlot(slotId)
    return result
  }

  /**
   * Finds the fork through the alternate at `index` of the message at `entry` (DESIGN §3.2).
   * Nothing moves: the caller opens it (`?fork=`), where the user is.
   */
  async switchBranch(entry: PathEntry, index: number): Promise<Outcome<BranchSwitch>> {
    const result = await this.call((client) =>
      client("SwitchBranch", { chatId: this.chatId, slotId: entry.slotId, index, forkId: this.view.forkId })
    )
    if (result.ok) this.update({ chat: result.value.chat })
    return result
  }

  /**
   * "Branch from here": a fork of the one shown, at `at`, which becomes the chat's current
   * fork, named `name` ("From #14"). Its composer starts as a copy of this one's (DESIGN §6.2).
   */
  async branchFrom(at: SlotId, notes?: ForkNoteSelection, fromForkId = this.view.forkId, name?: string) {
    const result = await this.call((client) =>
      client("CreateFork", {
        chatId: this.chatId,
        fromForkId,
        atSlotId: at,
        ...(notes ? { notes } : {}),
        ...(name === undefined ? {} : { name })
      })
    )
    if (result.ok) {
      this.branchStart = result.value.fork.id
      this.update({ chat: result.value.chat })
      // Opened at the message it was made at, which the URL keeps (ForkNotesDialog.tsx).
      this.showFork(null, at)
    }
    return result
  }

  // --- For the composer (composerDraft.ts).

  /** A fork the user is starting with "Branch from here" (DESIGN §6.2: it takes the composer along). */
  private branchStart: ForkId | null = null

  /** Whether `fork` is the fork being started; it is only once. */
  takeBranchStart(fork: ForkId | null): boolean {
    if (fork === null || fork !== this.branchStart) return false
    this.branchStart = null
    return true
  }

  private refreshSlot(slotId: SlotId) {
    return this.reading(async () => {
      const window = await this.read({ _tag: "Around", slot: slotId }, 1)
      const entry = window?.entries.find((e) => e.slotId === slotId)
      if (entry) this.applySlot(entry)
    })
  }
}
