// The composer's text as a server draft (DESIGN §6.2): one per branch tip, saved while the
// user types, read back on a reload or another device, with its undo history on the server.
// It follows the editors' rules (features/editor/store.ts): a copy in this browser while a
// change isn't on the server (backup.ts), a keepalive send as the page closes, a warning
// before closing with a change unsent, and a save counts only once the server answers.
//
// The box's text belongs to the draft it was typed into, which is kept apart from the tip
// the chat view asks for: a draft moves with its tip when a message is appended there, so
// every save names the draft (its id, row version and session), and the server puts the
// text wherever that draft is now (ARCHITECTURE §3.10). Going to another tip, the text is
// saved on its own draft first; if the new tip's draft turns out to be the same one (it
// moved there), the text stays in the box. Server calls run one at a time, in order.
import type { SlotId } from "@rp/shared/chat.ts"
import type { SendResult } from "@rp/shared/chatApi.ts"
import type { Draft, DraftState } from "@rp/shared/drafts.ts"
import type { AppError } from "../../errors.ts"
import { copiesOf, dropCopy, keepCopy, pruneCopies } from "../editor/backup.ts"
import type { ChatSession, Outcome } from "./session.ts"

/** How long typing pauses before the text is saved. */
const SAVE_DELAY_MS = 600
/** The most a `keepalive` request may carry, in bytes, in the browsers that cap it. */
const KEEPALIVE_LIMIT = 64 * 1024
/** How long a composer that couldn't be read waits before it's read again. */
const RETRY_MS = 2000

export interface ComposerState {
  readonly text: string
  /** The tip's text is loaded, so the box takes input. */
  readonly ready: boolean
  /** The text came back from this browser's copy, made as a page closed before the server had it. */
  readonly restored: boolean
  /** Text typed here after it was sent from another tab went to the bin's recovered text. */
  readonly recovered: boolean
  /** The last save that failed, until one succeeds. */
  readonly error: AppError | null
}

/** A send's outcome as the composer needs it: not sent, or the draft as the send left it. */
export type Sent = { readonly sent: false } | { readonly sent: true; readonly draft: SendResult["draft"] }

/** What this browser's copies (backup.ts) file a chat's composer under: a tip is its field. */
const copyTarget = (chatId: string) => `composer:${chatId}`

/** The draft's text as the box would show it: an ended draft holds none. */
const shown = (draft: Draft | null) => (draft?.status === "active" ? draft.content : "")

export class ComposerDraft {
  /** The tip the chat view shows, which the box is on its way to. */
  private requested: SlotId | null | undefined = undefined
  /** The draft the text in the box was typed into, as this tab last had it. */
  private draft: Draft | null = null
  private text = ""
  private ready = false
  private restored = false
  private recovered = false
  private error: AppError | null = null
  /** A send is on its way: the box holds the next message, saved once the send is answered. */
  private held = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  private state: ComposerState = { text: "", ready: false, restored: false, recovered: false, error: null }

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
    const { text, ready, restored, recovered, error } = this
    this.state = { text, ready, restored, recovered, error }
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

  /** The text differs from the draft it was typed into. */
  private get dirty() {
    return this.draft !== null && this.text !== shown(this.draft)
  }

  /** Where this browser's copy of the text is filed: the tip its draft was at. */
  private get field() {
    return this.draft?.key.field ?? this.requested ?? ""
  }

  // --- The tip

  /**
   * The path's leaf, as the chat view has it. `appended`: messages were appended below the
   * last tip, so its draft most likely moved here, and the box stays open while that's
   * checked. `branch`: a branch is being started here, whose composer starts as a copy.
   */
  setTip(tip: SlotId | null, appended: boolean, branch: boolean) {
    if (tip === this.requested) return
    this.requested = tip
    if (!appended || this.draft === null) {
      this.ready = false
      this.emit()
    }
    void this.enqueue(() => this.goTo(tip, branch))
  }

  private async goTo(tip: SlotId | null, branch: boolean): Promise<void> {
    if (this.requested !== tip) return
    // A send taken from the box before this step ran is answered first.
    if (this.held) return void this.enqueue(() => this.goTo(tip, branch))
    // A branch starts from the composer as the server has it, so what's typed is saved first.
    if (branch) await this.save()
    const copyFrom = branch && this.draft !== null ? { copyFrom: this.draft.id } : {}
    const opened = await this.session.call((client) =>
      client("OpenComposer", { chatId: this.chatId, tipSlotId: tip, ...copyFrom })
    )
    // The chat view reports why a read failed. A chat or tip that's gone stays shut; anything
    // else (the connection, say) is tried again.
    if (!opened.ok) {
      if (opened.error.tag !== "NotFound") setTimeout(() => void this.enqueue(() => this.goTo(tip, branch)), RETRY_MS)
      return
    }
    const draft = opened.value
    if (this.draft !== null && draft.id === this.draft.id) {
      // The draft came here itself: a message was appended at its tip, or the leaf went up
      // from a deleted message or back down onto a restored one. The text stays.
      this.rebase(draft)
      if (this.requested === tip) this.ready = true
      this.emit()
      return
    }
    // Another composer: the text goes where it was typed first.
    await this.save()
    if (this.requested === tip) await this.show(tip, draft)
  }

  /** The tip's text in the box, or what this browser kept of it when a page closed. */
  private async show(tip: SlotId | null, draft: Draft) {
    this.draft = draft
    this.text = shown(draft)
    this.error = null
    this.restored = false
    this.recovered = false
    await pruneCopies(this.userId)
    const copy = (await copiesOf(this.userId, copyTarget(this.chatId))).find((c) => c.field === draft.key.field)
    if (this.requested !== tip) return
    if (copy !== undefined && copy.content !== this.text) {
      this.text = copy.content
      this.restored = true
    } else if (copy !== undefined) void dropCopy(this.userId, copyTarget(this.chatId), copy.field, copy.content)
    if (this.carried !== "" && this.text === "") this.text = this.carried
    this.carried = ""
    this.ready = true
    this.emit()
    if (this.dirty) this.schedule(0)
  }

  /**
   * A newer state of the draft the text was typed into. Text not changed here takes it;
   * text changed here keeps the draft it was typed into, so its save goes on top of the
   * newer text, which stays one step back in the history (or, if the draft's text was sent
   * meanwhile, to the recovered texts).
   */
  private rebase(draft: Draft) {
    if (this.held || this.draft === null) return
    if (this.dirty) return this.schedule(0)
    if (draft.key.field !== this.draft.key.field) {
      void dropCopy(this.userId, copyTarget(this.chatId), this.draft.key.field, this.text)
    }
    this.draft = draft
    this.text = shown(draft)
  }

  /** The tip the box is on, or on its way to. */
  get tip() {
    return this.requested
  }

  // --- Typing and saving

  type(text: string) {
    this.text = text
    if (this.draft !== null) void keepCopy(this.userId, copyTarget(this.chatId), this.field, text)
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

  private request(draft: Draft, content: string) {
    return this.session.call((client) =>
      client("SaveComposer", {
        chatId: this.chatId,
        draftId: draft.id,
        rowVersion: draft.rowVersion,
        session: draft.session,
        content
      })
    )
  }

  /** Saves the text onto the draft it was typed into. */
  private async save() {
    const draft = this.draft
    if (this.held || draft === null || !this.dirty) return
    const text = this.text
    const saved = await this.request(draft, text)
    if (!saved.ok) {
      this.error = saved.error
      this.emit()
      return
    }
    void dropCopy(this.userId, copyTarget(this.chatId), draft.key.field, text)
    this.error = null
    const now = saved.value.draft
    if (!saved.value.recovered && now !== null) {
      this.draft = now
      return this.emit()
    }
    // The draft's text was sent from another tab, or the draft is gone: what was typed here
    // is in the recovered texts, and the box shows the composer as it is now.
    this.recovered = saved.value.recovered
    const current = now ?? (await this.reopen())
    if (current === null) return this.emit()
    this.draft = current
    // Typed on while the save was out: that stays, on the composer as it is now.
    if (this.text === text) this.text = shown(current)
    this.emit()
    if (this.dirty) this.schedule(0)
  }

  /** The composer at the tip asked for, read again. */
  private async reopen() {
    const tip = this.requested
    if (tip === undefined) return null
    const opened = await this.session.call((client) => client("OpenComposer", { chatId: this.chatId, tipSlotId: tip }))
    return opened.ok ? opened.value : null
  }

  // --- Sending

  /**
   * Sends the box's text: it leaves the box at once, so what's typed from then on is the
   * next message. The text is saved on the draft it was typed into, and `run` sends it from
   * there, committing that draft (ARCHITECTURE §3.10). If it isn't sent, it comes back to
   * the box, ahead of anything typed since.
   */
  submit(run: (text: string, from: Draft) => Promise<Sent>): Promise<void> {
    const from = this.draft
    if (from === null || this.held) return Promise.resolve()
    const text = this.text
    this.cancelTimer()
    this.held = true
    this.text = ""
    this.emit()
    return this.enqueue(async () => {
      let saved = from
      if (text !== shown(from)) {
        const result = await this.request(from, text)
        if (!result.ok || result.value.recovered || result.value.draft === null) {
          if (!result.ok) this.error = result.error
          return this.giveBack(text, result.ok ? (result.value.draft ?? from) : from)
        }
        saved = result.value.draft
      }
      const outcome = await run(text, saved)
      if (!outcome.sent) return this.giveBack(text, saved)
      this.held = false
      void dropCopy(this.userId, copyTarget(this.chatId), from.key.field, text)
      const after = outcome.draft ?? (await this.reopen())
      if (after !== null && after.session !== saved.session) this.draft = after
      else if (after !== null && this.text === "") {
        // Not committed: another tab typed on before the send arrived. Its text shows.
        this.draft = after
        this.text = shown(after)
      }
      // Otherwise what's typed since goes on top of that tab's text, theirs one step back.
      else this.draft = saved
      // What's typed since is filed where its draft is now.
      if (this.dirty && this.field !== from.key.field) {
        void dropCopy(this.userId, copyTarget(this.chatId), from.key.field, this.text)
        void keepCopy(this.userId, copyTarget(this.chatId), this.field, this.text)
      }
      this.emit()
      if (this.dirty) this.schedule(SAVE_DELAY_MS)
    })
  }

  /** The text of a send that didn't go, back in the box ahead of what's typed since, on `draft`. */
  private giveBack(text: string, draft: Draft) {
    this.held = false
    this.draft = draft
    this.text = this.text === "" ? text : `${text}\n\n${this.text}`
    this.emit()
    if (this.dirty) this.schedule(0)
  }

  // --- Undo from the server's history

  async history(): Promise<Outcome<ReadonlyArray<DraftState>>> {
    await this.flush()
    const draft = this.draft
    if (draft === null) return { ok: true, value: [] }
    return this.session.call((client) =>
      client("ComposerHistory", { chatId: this.chatId, draftId: draft.id, limit: 50 })
    )
  }

  /**
   * Moves the text back to an earlier state; the restore is in the history too. Text typed
   * while it's on its way stays in the box, saved on top of the restored state.
   */
  restore(seq: number): Promise<Outcome<Draft> | null> {
    this.cancelTimer()
    return this.enqueue(async () => {
      await this.save()
      const draft = this.draft
      if (draft === null || this.held) return null
      const typed = this.text
      const result = await this.session.call((client) =>
        client("RestoreComposer", { chatId: this.chatId, draftId: draft.id, seq, expectedRowVersion: draft.rowVersion })
      )
      if (result.ok) {
        this.draft = result.value
        if (this.text === typed) this.text = shown(result.value)
        this.emit()
        if (this.dirty) this.schedule(0)
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
   * request, or while a send is out (the box then holds the next message, for a draft the
   * send hasn't committed yet), only the copy in this browser keeps the text.
   */
  beacon() {
    const draft = this.draft
    if (draft === null || this.held || !this.dirty || this.sent === this.text) return
    const text = this.text
    const body = JSON.stringify({
      drafts: [],
      composers: [
        { chatId: this.chatId, draftId: draft.id, rowVersion: draft.rowVersion, session: draft.session, content: text }
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
        void dropCopy(this.userId, copyTarget(this.chatId), draft.key.field, text)
      },
      () => undefined
    )
  }
}
