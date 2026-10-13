// One open chat (CLIENT-FRAMEWORK §5): the loaded window of its path, kept current by its
// subscription, and the text of versions still generating. The server is the source of
// truth: the window is what reads and events said, and writes apply the server's reply.
//
// Streamed text never goes through the list. Each generating version's text is an atom
// of its own, which only its message's body reads, and deltas are applied once per
// animation frame, so a token re-renders one row.
import {
  type Chat,
  type ChatId,
  type EntityId,
  type PathEntry,
  type QueuedMessage,
  type SlotId,
  type Version,
  type VersionId,
  versionInContext
} from "@rp/shared/chat.ts"
import type { Cast, CastChange } from "@rp/shared/chatSetupApi.ts"
import type { CardFields } from "@rp/shared/macros/context.ts"
import { NotFound } from "@rp/shared/errors.ts"
import type { BranchSwitch, ChatEvent, PathRange, PathWindow, SendResult } from "@rp/shared/chatApi.ts"
import type { CacheWarmth, NextContext } from "@rp/shared/inspectorApi.ts"
import type { LcmCoverage, LcmState } from "@rp/shared/lcm.ts"
import { Cause, Context, Effect, Exit, Fiber, Schedule, Stream } from "effect"
import { Atom, type AtomRegistry, AtomRegistry as Registry, Reactivity } from "effect/reactivity"
import { type AppError, describeCause } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { sessionAtom } from "../../session.ts"
import { mountedBodies, PERF, perf } from "./perf.ts"
import type { ComposerSource } from "./composerDraft.ts"

/** How many slots one read asks for. */
const PAGE = 60
/** At most this many slots stay loaded; the far end is dropped, and read again when needed. */
const MAX_LOADED = 500

/** Whether this version is held behind a cold-prefix writer. */
export const waitingCache = Atom.family((_id: VersionId) => Atom.make(false))

/** The text so far of a version that's generating, by its id; null when it isn't. */
export const liveText = Atom.family((_id: VersionId) => Atom.make<string | null>(null))

export interface ChatView {
  readonly chat: Chat | null
  /** The path's leaf, as the server resolved it. */
  readonly leafSlotId: SlotId | null
  readonly entries: ReadonlyArray<PathEntry>
  /** Where to continue reading older history; null at the root. */
  readonly older: SlotId | null
  /** Where to continue reading newer history; null when the window reaches the leaf. */
  readonly newer: SlotId | null
  /** Whether a message added at the end scrolls into view: not while paging down. */
  readonly follow: boolean
  /** Bumped when the window is replaced rather than extended, so the list can position it. */
  readonly opened: number
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
  readonly history: Pick<NextContext, "leafSlotId" | "historyStart" | "summarizedThrough"> | null
  /** What stands in for older history on the path shown (DESIGN §8); null until read. */
  readonly lcm: LcmState | null
  /** Bumped each time the summaries are read and differ, so a window of coverage reads again. */
  readonly lcmVersion: number
}

type Client = AppClient["Service"]
/** The events that change loaded state, and are applied again after a read lands. */
type Replayable = Extract<ChatEvent, { readonly _tag: "Slot" | "Version" | "Chat" }>
/** What a send names of the composer draft it took its text from, which it commits. */
const commitOf = ({ draftId, session, text }: ComposerSource) => ({ draftId, session, text })

export type Outcome<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: AppError }

const withInContext = (entry: PathEntry, version: Version) =>
  ({
    ...entry,
    version,
    inContext: versionInContext(version.status, version.content, entry.contextExcluded)
  }) as PathEntry

export class ChatSession {
  private view: ChatView = {
    chat: null,
    leafSlotId: null,
    entries: [],
    older: null,
    newer: null,
    follow: true,
    opened: 0,
    loading: true,
    error: null,
    deleted: false,
    cast: null,
    queue: [],
    cache: null,
    history: null,
    lcm: null,
    lcmVersion: 0
  }
  private readonly listeners = new Set<() => void>()
  /** Unmounts for the live atoms kept alive while their version generates, shown or not. */
  private readonly live = new Map<VersionId, () => void>()
  /** Deltas received since the last frame, by version. */
  private readonly pending = new Map<VersionId, Array<{ readonly offset: number; readonly text: string }>>()
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

  private readonly chatId: ChatId
  /** The leaf the URL asks for; null follows the chat's active leaf. */
  private requestedLeaf: SlotId | null
  private readonly registry: AtomRegistry.AtomRegistry

  /** The chat this session shows. */
  get id(): ChatId {
    return this.chatId
  }

  constructor(chatId: ChatId, requestedLeaf: SlotId | null, registry: AtomRegistry.AtomRegistry) {
    this.chatId = chatId
    this.requestedLeaf = requestedLeaf
    this.registry = registry
  }

  // --- For React (useSyncExternalStore)

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
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

  private contextReads = 0

  private lcmReads = 0
  private lcmTimer: ReturnType<typeof setTimeout> | null = null

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
    const leafSlotId = this.view.leafSlotId
    if (leafSlotId === null || this.disposed) return
    const result = await this.call((client) => client("GetLcmState", { chatId: this.chatId, leafSlotId }))
    if (!result.ok || this.disposed || read !== this.lcmReads || leafSlotId !== this.view.leafSlotId) return
    // The same layer again (the leaf moved on, a reply streamed) changes nothing on screen.
    if (JSON.stringify(result.value) === JSON.stringify(this.view.lcm)) return
    this.update({ lcm: result.value, lcmVersion: this.view.lcmVersion + 1 })
  }

  /** The summaries overlapping a range of message depths on the path shown, without their text. */
  async coverage(fromDepth: number, toDepth: number): Promise<LcmCoverage | null> {
    const leafSlotId = this.view.leafSlotId
    if (leafSlotId === null) return null
    const result = await this.call((client) =>
      client("GetLcmCoverage", { chatId: this.chatId, leafSlotId, fromDepth, toDepth })
    )
    return result.ok && !this.disposed ? result.value : null
  }

  private async refreshContext() {
    const read = ++this.contextReads
    const leafSlotId = this.view.leafSlotId
    if (leafSlotId === null) return
    const result = await this.call((client) => client("GetNextContext", { chatId: this.chatId, leafSlotId }))
    if (!result.ok || this.disposed || read !== this.contextReads || leafSlotId !== this.view.leafSlotId) return
    this.apply({ _tag: "Cache", ...result.value }, null)
  }

  /** Bumped by every cast read, so an older reply is dropped. */
  private castReads = 0

  private async refreshCast() {
    const read = ++this.castReads
    const slotId = this.view.leafSlotId
    const result = await this.call((client) => client("GetCast", { chatId: this.chatId, slotId }))
    if (!result.ok || read !== this.castReads || this.disposed) return
    // Unchanged, it stays the same object: every message row reads it.
    if (JSON.stringify(result.value) !== JSON.stringify(this.view.cast)) this.update({ cast: result.value })
  }

  // --- The cast at a message's position, for text whose macros follow the chat's state
  // there (DESIGN §5.6): a greeting's `{{user}}` is whoever the user played before it.

  private readonly positionCasts = new Map<string, Cast | "loading">()
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
    void this.call((client) => client("GetCast", { chatId: this.chatId, slotId })).then((result) => {
      if (this.disposed) return
      if (result.ok) this.positionCasts.set(key, result.value)
      else this.positionCasts.delete(key)
      for (const listener of this.positionListeners) listener()
    })
    return undefined
  }

  private forgetPositions() {
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

  /**
   * Subscribes, and opens the chat on the first Hello: subscribing before reading means
   * no change can fall between the two (chatApi.ts).
   */
  start(anchor: SlotId | null) {
    this.disposed = false
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
    if (this.lcmTimer !== null) clearTimeout(this.lcmTimer)
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    if (this.subscription) Effect.runFork(Fiber.interrupt(this.subscription))
    for (const [id, unmount] of this.live) {
      this.registry.set(waitingCache(id), false)
      this.registry.set(liveText(id), null)
      unmount()
    }
    this.live.clear()
  }

  // --- Reading windows

  private async read(range: PathRange, limit = PAGE): Promise<PathWindow | null> {
    const result = await this.call((client) =>
      client("ReadPath", { chatId: this.chatId, leafSlotId: this.view.leafSlotId ?? this.requestedLeaf, range, limit })
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

  /** Replaces the window: at the bottom, or around a slot; `reposition` scrolls to it. */
  open(anchor: SlotId | null, limit = PAGE, reposition = true) {
    const generation = ++this.generation
    this.update({ loading: this.view.entries.length === 0 })
    return this.reading(async () => {
      const [window, chat] = await Promise.all([
        this.read(anchor === null ? { _tag: "Bottom" } : { _tag: "Around", slot: anchor }, limit),
        this.call((client) => client("GetChat", { chatId: this.chatId }))
      ])
      if (window === null || this.disposed || generation !== this.generation) return
      this.update({
        chat: chat.ok ? chat.value : this.view.chat,
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
      void this.refreshCast()
      void this.refreshQueue()
    })
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

  /** Shows another branch (null: the chat's active one), at a message or at its bottom. */
  showBranch(leaf: SlotId | null, anchor: SlotId | null) {
    this.requestedLeaf = leaf
    this.update({ leafSlotId: leaf, entries: [], loading: true })
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
      // Anything else applies after the text that came before it.
      this.flush()
      this.apply(event, anchor)
    }
    if (this.pending.size > 0 && this.frame === null) {
      this.frame = requestAnimationFrame(() => {
        this.frame = null
        this.flush()
      })
    }
  }

  /** Applies the deltas received so far: one atom update per version. */
  private flush() {
    if (this.pending.size === 0) return
    Atom.batch(() => {
      for (const [id, deltas] of this.pending) {
        let text = this.registry.get(liveText(id)) ?? ""
        for (const { offset, text: added } of deltas) {
          if (offset > text.length) {
            if (PERF) perf.gaps++
          } else if (offset + added.length > text.length) text = text.slice(0, offset) + added
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

  private apply(event: Exclude<ChatEvent, { readonly _tag: "Delta" }>, anchor: SlotId | null) {
    switch (event._tag) {
      case "Hello": {
        for (const { versionId, text, waitingCache: waiting } of event.live) {
          this.registry.set(waitingCache(versionId), waiting ?? false)
          if (text.length >= (this.registry.get(liveText(versionId)) ?? "").length) this.setLive(versionId, text)
        }
        // The first Hello opens the chat. Another means the socket reconnected, and
        // anything may have changed meanwhile.
        if (this.hellos++ === 0) return void this.open(anchor)
        // Anything that stopped generating while the socket was down lost its Version
        // event: its live text would hide the saved one.
        const live = new Set(event.live.map((l) => l.versionId))
        for (const id of [...this.live.keys()]) if (!live.has(id)) this.endLive(id)
        this.reload()
        return
      }
      case "Slot":
      case "Version":
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
        return void this.refreshCast()
      case "Lcm":
        return this.scheduleLcm()
      case "WaitingCache":
        if (!this.live.has(event.versionId)) this.setLive(event.versionId, "")
        this.registry.set(waitingCache(event.versionId), event.waiting)
        return
      case "Cache": {
        // An edit, a swipe, a delete or a hide can make a summary stale; the estimate follows
        // every such change, so the layer is read again with it.
        this.scheduleLcm()
        if (event.leafSlotId !== this.view.leafSlotId) {
          void this.refreshContext()
          return
        }
        this.contextReads++
        // The same estimate again (another tab subscribed) changes nothing on screen.
        const history = {
          leafSlotId: event.leafSlotId,
          historyStart: event.historyStart,
          summarizedThrough: event.summarizedThrough
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
    this.scheduleLcm()
    const { entries, newer } = this.view
    const limit = Math.min(MAX_LOADED, Math.max(PAGE, entries.length))
    if (newer === null || entries.length === 0) return void this.open(null, limit, entries.length === 0)
    void this.open(entries[Math.floor(entries.length / 2)]!.slotId, limit, false)
  }

  /**
   * A slot added or changed; returns whether it's in the window. A new one joins when it
   * continues the loaded bottom of the path.
   */
  private applySlot(entry: PathEntry): boolean {
    const { entries } = this.view
    const index = entries.findIndex((e) => e.slotId === entry.slotId)
    if (index >= 0) {
      const current = entries[index]!
      if (current.rowVersion > entry.rowVersion) return true
      const next = entries.slice()
      // A finished version may arrive before the slot event that started it.
      const finished = current.version.id === entry.version.id && current.version.status !== "generating"
      const stored = finished && entry.version.status === "generating" ? withInContext(entry, current.version) : entry
      next[index] = stored
      this.update({ entries: next })
      this.track(stored.version)
      return true
    }
    if (this.view.newer !== null || entry.parentSlotId !== (entries.at(-1)?.slotId ?? null)) {
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
      // The path's leaf moves on below the window too, so the composer follows it.
      if (this.view.newer !== null && entry.parentSlotId !== null && entry.parentSlotId === this.view.leafSlotId) {
        this.lastAppend = { from: entry.parentSlotId, to: entry.slotId }
        this.update({ leafSlotId: entry.slotId })
      }
      return false
    }
    this.lastAppend = { from: entry.parentSlotId, to: entry.slotId }
    let next = [...entries, entry]
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
   * A message this tab added at the leaf. When the window doesn't reach the leaf (opened
   * at an older message), the chat opens at the bottom, where the message is.
   */
  private appended(entry: PathEntry, chat: Chat) {
    this.update({ chat })
    this.followAtBottom()
    if (this.applySlot(entry)) return
    this.requestedLeaf = null
    this.lastAppend = { from: entry.parentSlotId, to: entry.slotId }
    this.update({ leafSlotId: entry.slotId })
    void this.open(null)
  }

  private applyVersion(version: Version) {
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
  }

  private mountLive(id: VersionId) {
    const text = this.registry.mount(liveText(id))
    const waiting = this.registry.mount(waitingCache(id))
    return () => {
      text()
      waiting()
    }
  }

  private setLive(id: VersionId, text: string) {
    if (!this.live.has(id)) this.live.set(id, this.mountLive(id))
    this.registry.set(liveText(id), text)
  }

  private endLive(id: VersionId) {
    this.pending.delete(id)
    this.registry.set(waitingCache(id), false)
    this.registry.set(liveText(id), null)
    this.live.get(id)?.()
    this.live.delete(id)
  }

  // --- Writes. Each applies the server's reply at once; its event, arriving too, changes nothing.

  /** Whether the view is a branch other than the active one, where a new message must say so. */
  private onOtherBranch() {
    const { chat, leafSlotId } = this.view
    return chat !== null && leafSlotId !== chat.activeLeafSlotId
  }

  /**
   * The user's message at the leaf, as `speaker` (Send as X), then a reply to it by
   * `replySpeaker`. Onto a reply still being written, it's queued and the server posts it,
   * with its reply, when that one ends (DESIGN §2.2). `sent` says whether the message went,
   * and `draft` is the composer draft as the send left it.
   */
  async send(
    content: string,
    speaker: EntityId | null = null,
    replySpeaker: EntityId | null = null,
    /** The composer draft the text came from, which the send commits (DESIGN §6.2). */
    composer?: ComposerSource
  ): Promise<{
    readonly sent: boolean
    readonly outcome: Outcome<unknown>
    readonly draft: SendResult["draft"]
    readonly recovered: number
  }> {
    const parentSlotId = composer === undefined ? this.view.leafSlotId : composer.tip
    const result = await this.queueSnapshot(
      this.call((client) =>
        client("SendMessage", {
          chatId: this.chatId,
          parentSlotId,
          branch: this.onOtherBranch(),
          content,
          speakerEntityId: speaker,
          // If it's queued, the server asks for the reply when it posts, from the same speaker.
          replySpeakerEntityId: replySpeaker,
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
    return { sent: true, outcome: await this.generate(result.value.entry.slotId, replySpeaker), draft, recovered }
  }

  /**
   * A model reply at the leaf, or under the message just sent, as `speaker` (Generate X),
   * with a one-turn `direction`. Onto a reply still being written, it's queued.
   */
  async generate(
    parentSlotId = this.view.leafSlotId,
    speaker: EntityId | null = null,
    direction = "",
    composer?: ComposerSource
  ): Promise<Outcome<SendResult>> {
    const branch = parentSlotId === this.view.leafSlotId && this.onOtherBranch()
    const result = await this.queueSnapshot(
      this.call((client) =>
        client("Generate", {
          chatId: this.chatId,
          parentSlotId,
          branch,
          speakerEntityId: speaker,
          ...(direction.trim() === "" ? {} : { direction }),
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

  /** Changes who's in the chat, or a setting, from the leaf shown on (DESIGN §3.4). */
  async changeCast(change: CastChange): Promise<Outcome<Cast>> {
    const result = await this.call((client) =>
      client("ChangeCast", { chatId: this.chatId, slotId: this.view.leafSlotId, change })
    )
    if (result.ok) {
      this.castReads++
      this.update({ cast: result.value })
      this.forgetPositions()
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
    from: { readonly rowVersion: number; readonly speakerEntityId: EntityId | null }
  ): Promise<Outcome<QueuedMessage>> {
    return this.call((client) =>
      client("EditQueued", {
        queuedId: queued.id,
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

  async regenerate(entry: PathEntry): Promise<Outcome<unknown>> {
    return this.slotWrite(entry.slotId, (client) =>
      client("Regenerate", { slotId: entry.slotId, expectedRowVersion: entry.rowVersion })
    )
  }

  /** Shows another version at once, and puts the slot back as it was if the server refuses. */
  async select(entry: PathEntry, version: Version): Promise<Outcome<unknown>> {
    this.applySlot(withInContext(entry, version))
    const result = await this.slotWrite(entry.slotId, (client) =>
      client("SelectVersion", { slotId: entry.slotId, versionId: version.id, expectedRowVersion: entry.rowVersion })
    )
    if (!result.ok && result.error.tag !== "StaleWrite") this.applySlot(entry)
    return result
  }

  /** A finished version the user wrote changes in place; anything else gets a new version. */
  async edit(entry: PathEntry, content: string): Promise<Outcome<unknown>> {
    const { version } = entry
    if (version.writer === "human" && version.status !== "generating") {
      const result = await this.call((client) =>
        client("AmendVersion", { versionId: version.id, content, expectedRowVersion: version.rowVersion })
      )
      if (result.ok) this.applyVersion(result.value)
      else if (result.error.tag === "StaleWrite") void this.refreshSlot(entry.slotId)
      return result
    }
    return this.slotWrite(entry.slotId, (client) =>
      client("EditVersion", {
        slotId: entry.slotId,
        sourceVersionId: version.id,
        content,
        expectedRowVersion: entry.rowVersion
      })
    )
  }

  async stop(versionId: VersionId): Promise<Outcome<unknown>> {
    const result = await this.call((client) => client("StopGeneration", { versionId }))
    if (result.ok) this.applyVersion(result.value)
    return result
  }

  deleteMessage(slotId: SlotId) {
    return this.call((client) => client("DeleteMessage", { slotId }))
  }

  deleteVersion(versionId: VersionId) {
    return this.call((client) => client("DeleteVersion", { versionId }))
  }

  listVersions(slotId: SlotId) {
    return this.call((client) => client("ListVersions", { slotId }))
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
   * Switches to the alternate at `index` of the message at `entry` (DESIGN §3.2): the chat's
   * active leaf moves to that branch's tip, and the window follows it once the caller opens
   * it where the user is.
   */
  async switchBranch(entry: PathEntry, index: number): Promise<Outcome<BranchSwitch>> {
    const result = await this.call((client) =>
      client("SwitchBranch", { chatId: this.chatId, slotId: entry.slotId, index })
    )
    if (result.ok) {
      this.requestedLeaf = null
      this.update({ chat: result.value.chat, leafSlotId: result.value.chat.activeLeafSlotId })
    }
    return result
  }

  // --- Where the leaf went, for the composer (composerDraft.ts).

  /** The last time the leaf moved by a message appended below it. */
  private lastAppend: { readonly from: SlotId | null; readonly to: SlotId } | null = null

  /**
   * Whether the leaf's last move was from `from` to `to` by a message appended below it (a
   * send, a reply, the queue posting), rather than a jump elsewhere.
   */
  movedByAppend(from: SlotId | null, to: SlotId | null): boolean {
    return this.lastAppend !== null && this.lastAppend.from === from && this.lastAppend.to === to
  }

  /** A branch the user is starting with "Branch from here" (DESIGN §6.2: it takes the composer along). */
  private branchStart: SlotId | null = null

  startBranch(at: SlotId) {
    this.branchStart = at
  }

  /** Whether `tip` is the branch being started; it is only once. */
  takeBranchStart(tip: SlotId | null): boolean {
    if (tip === null || tip !== this.branchStart) return false
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
