// The composer's text as a server draft (DESIGN §6.2): one per branch tip, saved while the
// user types, read back on a reload or another device, with its undo history on the server.
// It follows the editors' rules (features/editor/store.ts): a copy in this browser while a
// change isn't on the server (backup.ts), a keepalive send as the page closes, a warning
// before closing with a change unsent, and a save counts only once the server answers.
//
// The tip is the path's leaf. When messages are appended below it (a send, a reply, the queue
// posting) the server moves the draft along, and so does the text in the box; any other move
// (another branch, a deep link) saves the text where it was typed and shows the new tip's.
// Server calls run one at a time, in order, so a save never races a move.
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import type { Draft, DraftState } from "@rp/shared/drafts.ts"
import type { AppError } from "../../errors.ts"
import { copiesOf, dropCopy, keepCopy, pruneCopies } from "../editor/backup.ts"
import type { ChatSession, Outcome } from "./session.ts"

/** How long typing pauses before the text is saved. */
const SAVE_DELAY_MS = 600
/** The most a `keepalive` request may carry, in bytes, in the browsers that cap it. */
const KEEPALIVE_LIMIT = 64 * 1024

export interface ComposerState {
  readonly text: string
  /** The tip's text is loaded, so the box takes input. */
  readonly ready: boolean
  /** The text came back from this browser's copy, made as a page closed before the server had it. */
  readonly restored: boolean
  /** The last save that failed, until one succeeds. */
  readonly error: AppError | null
}

/** What this browser's copies (backup.ts) file a chat's composer under: a tip is its field. */
const copyTarget = (chatId: ChatId) => `composer:${chatId}`
const fieldOf = (tip: SlotId | null) => tip ?? ""

export class ComposerDraft {
  private tip: SlotId | null | undefined = undefined
  private text = ""
  /** The draft as the server last said, or null if it has none at this tip. */
  private server: Draft | null = null
  /** The text differs from what the server holds. */
  private dirty = false
  private ready = false
  private restored = false
  private error: AppError | null = null
  /** A send is on its way: nothing is saved until it's answered. */
  private held = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  private state: ComposerState = { text: "", ready: false, restored: false, error: null }

  private readonly session: ChatSession
  private readonly userId: string
  /** Text carried over from the card's page (composerCarry.ts), for an empty composer. */
  private carried: string

  constructor(session: ChatSession, userId: string, carried: string) {
    this.session = session
    this.userId = userId
    this.carried = carried
  }

  // --- For React (useSyncExternalStore)

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly snapshot = () => this.state

  private emit() {
    this.state = { text: this.text, ready: this.ready, restored: this.restored, error: this.error }
    for (const listener of this.listeners) listener()
  }

  /** Runs `step` after every server call before it. */
  private enqueue<A>(step: () => Promise<A>): Promise<A> {
    const run = this.queue.then(step, step)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private get chatId() {
    return this.session.id
  }

  private get(tip: SlotId | null) {
    return this.session.call((client) => client("GetComposer", { chatId: this.chatId, tipSlotId: tip }))
  }

  /** The draft's text as the box would show it: an ended draft holds none. */
  private static shown(draft: Draft | null) {
    return draft?.status === "active" ? draft.content : ""
  }

  // --- The tip

  /** The path's leaf, as the chat view has it; `continued` when messages were appended below the last. */
  setTip(tip: SlotId | null, continued: boolean) {
    if (tip === this.tip) return
    const from = this.tip
    this.tip = tip
    this.cancelTimer()
    if (from !== undefined && continued) {
      // The copy in this browser goes along too: a slot that's no tip any more keeps none.
      if (this.dirty) {
        void dropCopy(this.userId, copyTarget(this.chatId), fieldOf(from), this.text)
        void keepCopy(this.userId, copyTarget(this.chatId), fieldOf(tip), this.text)
      }
      void this.enqueue(() => this.followTo(tip))
      return
    }
    const leaving = from !== undefined && this.dirty ? { tip: from, text: this.text, server: this.server } : null
    this.ready = false
    this.emit()
    void this.enqueue(async () => {
      const result = await this.get(tip)
      if (this.tip !== tip) return
      if (!result.ok) {
        // Typing is better than a box that never opens: a save then goes on top of the
        // server's. The chat view reports why the read failed.
        await this.show(tip, null)
        return
      }
      const draft = result.value
      // The draft itself went there (the leaf moved up from a deleted message, or back
      // down onto a restored one): the text in the box goes along.
      if (leaving !== null && draft !== null && draft.id === leaving.server?.id) {
        this.server = draft
        this.ready = true
        this.adopt(draft)
        return
      }
      if (leaving !== null) await this.saveAt(leaving.tip, leaving.text, leaving.server)
      await this.show(tip, draft)
    })
  }

  /** The tip's text in the box, or what this browser kept of it when a page closed. */
  private async show(tip: SlotId | null, draft: Draft | null) {
    this.server = draft
    this.text = ComposerDraft.shown(draft)
    this.dirty = false
    await pruneCopies(this.userId)
    const copy = (await copiesOf(this.userId, copyTarget(this.chatId))).find((c) => c.field === fieldOf(tip))
    if (this.tip !== tip) return
    if (copy !== undefined && copy.content !== this.text) {
      this.text = copy.content
      this.dirty = true
      this.restored = true
    } else if (copy !== undefined) void dropCopy(this.userId, copyTarget(this.chatId), fieldOf(tip), copy.content)
    if (this.carried !== "" && this.text === "") {
      this.text = this.carried
      this.dirty = true
    }
    this.carried = ""
    this.ready = true
    this.emit()
    if (this.dirty) this.schedule(0)
  }

  /** Messages were appended below the tip: the server moved the draft here, the text stays. */
  private async followTo(tip: SlotId | null) {
    const result = await this.get(tip)
    if (!result.ok || this.tip !== tip) return
    this.server = result.value
    this.adopt(result.value)
  }

  /** Keeps the text in the box over `draft`, saving it if they differ. */
  private adopt(draft: Draft | null) {
    this.dirty = this.text !== ComposerDraft.shown(draft)
    this.emit()
    if (this.dirty) this.schedule(0)
  }

  // --- Typing and saving

  type(text: string) {
    this.text = text
    this.dirty = true
    if (this.tip !== undefined) void keepCopy(this.userId, copyTarget(this.chatId), fieldOf(this.tip), text)
    this.emit()
    this.schedule(SAVE_DELAY_MS)
  }

  private cancelTimer() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(delay: number) {
    this.cancelTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.enqueue(() => this.save())
    }, delay)
  }

  /** Saves what's typed now, after anything already on its way. */
  flush() {
    this.cancelTimer()
    return this.enqueue(() => this.save())
  }

  private async save() {
    if (this.held || !this.dirty || !this.ready || this.tip === undefined) return
    const tip = this.tip
    const text = this.text
    const saved = await this.saveAt(tip, text, this.server)
    if (this.tip !== tip) return
    if (saved.ok) {
      this.server = saved.value
      this.error = null
      if (this.text === text) this.dirty = false
    } else if (saved.error !== null) this.error = saved.error
    this.emit()
  }

  /**
   * Saves `text` at `tip` over the draft as last read. If another tab saved since, this goes
   * on top, theirs staying in the history. A draft gone from its tip moved on with the leaf:
   * it isn't made again behind it, and the copy in this browser keeps the text.
   */
  private async saveAt(
    tip: SlotId | null,
    text: string,
    server: Draft | null
  ): Promise<{ readonly ok: true; readonly value: Draft } | { readonly ok: false; readonly error: AppError | null }> {
    const attempt = (expectedRowVersion: number | null) =>
      this.session.call((client) =>
        client("SaveComposer", { chatId: this.chatId, tipSlotId: tip, content: text, expectedRowVersion })
      )
    let result: Outcome<Draft> = await attempt(server?.rowVersion ?? null)
    if (!result.ok && result.error.tag === "StaleWrite") {
      const current = await this.get(tip)
      if (!current.ok || current.value === null) return { ok: false, error: null }
      result = await attempt(current.value.rowVersion)
    }
    if (result.ok) void dropCopy(this.userId, copyTarget(this.chatId), fieldOf(tip), text)
    return result
  }

  // --- Sending

  /**
   * Before a send takes the text: everything typed is saved, and nothing more is until the
   * send is answered. Returns the draft's row version, for the send to commit it.
   */
  async hold(): Promise<number | undefined> {
    await this.flush()
    this.held = true
    return this.server?.status === "active" ? this.server.rowVersion : undefined
  }

  /** The box as the send left it: `rest` is what it holds now. */
  takeText(rest: string) {
    this.text = rest
    this.emit()
  }

  /**
   * The send was answered. If it went, the server committed the draft it took, whose copy in
   * this browser goes too; the box's text is saved on the draft as it is now.
   */
  release(sent: { readonly tip: SlotId | null; readonly text: string } | null) {
    this.held = false
    if (sent !== null) void dropCopy(this.userId, copyTarget(this.chatId), fieldOf(sent.tip), sent.text)
    const tip = this.tip
    if (tip === undefined) return
    void this.enqueue(async () => {
      if (this.tip === tip) await this.followTo(tip)
    })
  }

  get currentTip() {
    return this.tip
  }

  // --- Undo from the server's history

  async history(): Promise<Outcome<ReadonlyArray<DraftState>>> {
    await this.flush()
    const tip = this.tip ?? null
    return this.session.call((client) => client("ComposerHistory", { chatId: this.chatId, tipSlotId: tip, limit: 50 }))
  }

  /** Moves the text back to an earlier state; the restore is in the history too. */
  restore(seq: number): Promise<Outcome<Draft> | null> {
    this.cancelTimer()
    return this.enqueue(async () => {
      await this.save()
      const tip = this.tip
      const server = this.server
      if (tip === undefined || server === null) return null
      const result = await this.session.call((client) =>
        client("RestoreComposer", { chatId: this.chatId, tipSlotId: tip, seq, expectedRowVersion: server.rowVersion })
      )
      if (result.ok && this.tip === tip) {
        this.server = result.value
        this.text = result.value.content
        this.dirty = false
        this.emit()
      }
      return result
    })
  }

  // --- Leaving

  /** Text not on the server yet. */
  isUnsaved() {
    return this.dirty
  }

  /** What the server confirmed `beacon` sent, so closing doesn't send it twice. */
  private sent: string | null = null

  /**
   * As the page goes: what's typed and not saved yet, in a request that outlives the page,
   * with the editors' (POST /library/drafts). Past the browsers' 64 KB cap for such a
   * request, only the copy in this browser keeps the text. A send counts once answered.
   */
  beacon() {
    const tip = this.tip
    if (!this.dirty || tip === undefined || this.sent === this.text) return
    const text = this.text
    const body = JSON.stringify({
      drafts: [],
      composers: [
        { chatId: this.chatId, tipSlotId: tip, content: text, expectedRowVersion: this.server?.rowVersion ?? null }
      ]
    })
    if (new Blob([body]).size > KEEPALIVE_LIMIT) return
    void fetch("/library/drafts", {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body
    }).then(
      (response) => {
        if (!response.ok) return
        this.sent = text
        void dropCopy(this.userId, copyTarget(this.chatId), fieldOf(tip), text)
      },
      () => undefined
    )
  }
}
