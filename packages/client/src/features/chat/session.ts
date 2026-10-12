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
  type PathEntry,
  type SlotId,
  type Version,
  type VersionId,
  versionInContext
} from "@rp/shared/chat.ts"
import { NotFound } from "@rp/shared/errors.ts"
import type { ChatEvent, PathRange, PathWindow } from "@rp/shared/chatApi.ts"
import { Cause, Context, Effect, Exit, Fiber, Schedule, Stream } from "effect"
import { Atom, type AtomRegistry, AtomRegistry as Registry } from "effect/reactivity"
import { type AppError, describeCause } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { sessionAtom } from "../../session.ts"
import { perf } from "./perf.ts"

/** How many slots one read asks for. */
const PAGE = 60
/** At most this many slots stay loaded; the far end is dropped, and read again when needed. */
const MAX_LOADED = 500

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
}

type Client = AppClient["Service"]
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
    error: null
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

  private readonly chatId: ChatId
  /** The leaf the URL asks for; null follows the chat's active leaf. */
  private requestedLeaf: SlotId | null
  private readonly registry: AtomRegistry.AtomRegistry

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
    this.view = { ...this.view, ...change }
    this.report()
    for (const listener of this.listeners) listener()
  }

  private report() {
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

  private call<A, E>(rpc: (client: Client) => Effect.Effect<A, E>): Promise<Outcome<A>> {
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
        Stream.runForEach((batch) => Effect.sync(() => this.receive(batch, anchor)))
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
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    if (this.subscription) Effect.runFork(Fiber.interrupt(this.subscription))
    for (const [id, unmount] of this.live) {
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

  /** Replaces the window: at the bottom, or around a slot; `reposition` scrolls to it. */
  async open(anchor: SlotId | null, limit = PAGE, reposition = true) {
    const generation = ++this.generation
    this.update({ loading: this.view.entries.length === 0 })
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
  }

  async loadOlder() {
    const from = this.view.older
    if (from === null || this.paging || this.view.loading) return
    this.paging = true
    this.report()
    const generation = this.generation
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
  }

  async loadNewer() {
    const after = this.view.newer
    if (after === null || this.paging || this.view.loading) return
    this.paging = true
    this.report()
    const generation = this.generation
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
    perf.batches++
    for (const event of batch) {
      if (event._tag === "Delta") {
        perf.deltas++
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
          if (offset > text.length) perf.gaps++
          else if (offset + added.length > text.length) text = text.slice(0, offset) + added
        }
        this.setLive(id, text)
        perf.rowUpdates++
      }
    })
    this.pending.clear()
  }

  private apply(event: Exclude<ChatEvent, { readonly _tag: "Delta" }>, anchor: SlotId | null) {
    switch (event._tag) {
      case "Hello": {
        for (const { versionId, text } of event.live) {
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
        return this.applySlot(event.entry)
      case "Version":
        return this.applyVersion(event.version)
      case "Chat":
        return this.update({ chat: event.chat })
      case "Reload":
        return this.reload()
    }
  }

  /** Reads the loaded range again, as far as one read goes, keeping the same slots in view. */
  private reload() {
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
    if (this.view.newer !== null || entry.parentSlotId !== (entries.at(-1)?.slotId ?? null)) return false
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
    this.update({ leafSlotId: entry.slotId })
    void this.open(null)
  }

  private applyVersion(version: Version) {
    if (version.status !== "generating") this.endLive(version.id)
    const { entries } = this.view
    const index = entries.findIndex((e) => e.version.id === version.id)
    if (index < 0) return
    const next = entries.slice()
    next[index] = withInContext(entries[index]!, version)
    this.update({ entries: next })
  }

  /** Keeps a generating version's text alive while it streams, shown or not. */
  private track(version: Version) {
    if (version.status !== "generating" || this.live.has(version.id)) return
    const known = this.registry.get(liveText(version.id))
    this.live.set(version.id, this.registry.mount(liveText(version.id)))
    if (known === null) this.registry.set(liveText(version.id), version.content)
  }

  private setLive(id: VersionId, text: string) {
    if (!this.live.has(id)) this.live.set(id, this.registry.mount(liveText(id)))
    this.registry.set(liveText(id), text)
  }

  private endLive(id: VersionId) {
    this.pending.delete(id)
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

  /** The user's message at the leaf, then a reply to it. `sent` says whether the message went. */
  async send(content: string): Promise<{ readonly sent: boolean; readonly outcome: Outcome<unknown> }> {
    const result = await this.call((client) =>
      client("SendMessage", {
        chatId: this.chatId,
        parentSlotId: this.view.leafSlotId,
        branch: this.onOtherBranch(),
        content
      })
    )
    if (!result.ok) {
      if (result.error.tag === "LeafMoved") this.reload()
      return { sent: false, outcome: result }
    }
    this.appended(result.value.entry, result.value.chat)
    return { sent: true, outcome: await this.generate(result.value.entry.slotId) }
  }

  /** A model reply at the leaf, or under the message just sent. */
  async generate(parentSlotId = this.view.leafSlotId): Promise<Outcome<unknown>> {
    const branch = parentSlotId === this.view.leafSlotId && this.onOtherBranch()
    const result = await this.call((client) => client("Generate", { chatId: this.chatId, parentSlotId, branch }))
    if (result.ok) this.appended(result.value.entry, result.value.chat)
    else if (result.error.tag === "LeafMoved") this.reload()
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

  private async refreshSlot(slotId: SlotId) {
    const window = await this.read({ _tag: "Around", slot: slotId }, 1)
    const entry = window?.entries.find((e) => e.slotId === slotId)
    if (entry) this.applySlot(entry)
  }
}
