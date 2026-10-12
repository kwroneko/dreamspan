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
//
// This browser's copy of the text is a save waiting to be made: filed under the draft's id
// with the row version and session it names, so a draft that moved never strands it. Any
// chat's composer opening makes every such save there is, and the server decides each.
import type { SlotId } from "@rp/shared/chat.ts"
import type { SendResult } from "@rp/shared/chatApi.ts"
import type { Draft, DraftState } from "@rp/shared/drafts.ts"
import type { AppError } from "../../errors.ts"
import { type Copy, copiesOfUser, dropCopy, keepCopy, makeCopy, pendingOf, pruneCopies } from "../editor/backup.ts"
import type { ChatSession, Outcome } from "./session.ts"

/** How long typing pauses before the text is saved. */
const SAVE_DELAY_MS = 600
/** The most a `keepalive` request may carry, in bytes, in the browsers that cap it. */
const KEEPALIVE_LIMIT = 64 * 1024
/** How old another draft's copy in this browser is before an opening composer saves it. */
const STALE_COPY_MS = 30_000
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

/** What this browser's copies (backup.ts) file a chat's composer under. */
const COPIES = "composer:"
const copyTarget = (chatId: string) => `${COPIES}${chatId}`
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
  /** The pending save of the send on its way, and whether the server has it. */
  private sending: { saved: boolean; readonly copy: Copy | null } | null = null
  private pending: Copy | null = null
  private readonly inFlight = new WeakSet<Copy>()
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

  /** Capture the save at typing time, keeping requests already on their way separately. */
  private keep(text: string) {
    const draft = this.draft
    if (draft === null) return null
    const previous = this.pending
    const copy = makeCopy(this.userId, copyTarget(this.chatId), draft.id, {
      kind: "composer",
      payload: {
        chatId: this.chatId,
        draftId: draft.id,
        rowVersion: draft.rowVersion,
        session: draft.session,
        next: this.held,
        content: text
      }
    })
    this.pending = copy
    void keepCopy(copy, previous !== null && this.inFlight.has(previous) ? null : previous)
    return copy
  }

  private acknowledge(copy: Copy) {
    void dropCopy(copy)
    if (this.pending === copy) this.pending = null
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

  /** The tip's text in the box, with what this browser kept of it when a page closed. */
  private async show(tip: SlotId | null, opened: Draft) {
    this.error = null
    const { draft, restored, recovered, unsent } = await this.saveCopies(opened)
    this.draft = draft
    this.text = unsent ?? shown(draft)
    this.restored = restored
    this.recovered = recovered
    if (this.requested !== tip) return
    if (this.carried !== "" && this.text === "") this.text = this.carried
    this.carried = ""
    this.ready = true
    this.emit()
    if (this.dirty) this.schedule(0)
  }

  /**
   * Makes every save this browser kept for want of the server (a page closed first), any
   * chat's, and says what they did to `opened`: its text came back (`restored`), or went to
   * the recovered texts. A copy of `opened` that can't be saved now comes back as `unsent`.
   */
  private async saveCopies(opened: Draft) {
    let draft = opened
    let restored = false
    let recovered = false
    let unsent: string | null = null
    await pruneCopies(this.userId)
    // Another draft's copy only once it's stale: a tab still typing there makes its own saves.
    const now = Date.now()
    const copies = (await copiesOfUser(this.userId)).filter(
      (copy) =>
        copy.refId.startsWith(COPIES) && (copy.field.split(" ")[0] === opened.id || now - copy.at > STALE_COPY_MS)
    )
    copies.sort((a, b) => {
      const first = pendingOf(a)
      const second = pendingOf(b)
      return (
        a.at - b.at ||
        Number(first?.kind === "composer" && first.payload.next === true) -
          Number(second?.kind === "composer" && second.payload.next === true)
      )
    })
    for (const copy of copies) {
      const pending = pendingOf(copy)
      if (pending?.kind !== "composer") continue
      const { chatId, draftId, content: text } = pending.payload
      const saved = await this.session.call((client) => client("SaveComposer", pending.payload))
      if (!saved.ok && saved.error.tag !== "NotFound") {
        if (draftId === opened.id) {
          unsent = text
          this.pending = copy
        }
        continue
      }
      await dropCopy(copy)
      if (!saved.ok) continue
      const now = saved.value.draft
      if (now?.id === opened.id) {
        restored ||= shown(now) !== shown(draft)
        draft = now
      }
      recovered ||= saved.value.recovered && chatId === this.chatId
    }
    return { draft, restored: restored || unsent !== null, recovered, unsent }
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
    this.keep(text)
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

  private async request(copy: Copy) {
    const save = pendingOf(copy)!
    if (save.kind !== "composer") throw new Error("expected a composer save")
    this.inFlight.add(copy)
    try {
      return await this.session.call((client) => client("SaveComposer", save.payload))
    } finally {
      this.inFlight.delete(copy)
    }
  }

  /** Saves the pending request unchanged, even if an earlier save advanced the draft. */
  private async save() {
    if (this.held || this.draft === null || (!this.dirty && this.pending === null)) return
    const copy = this.pending ?? this.keep(this.text)!
    const saved = await this.request(copy)
    if (!saved.ok) {
      this.error = saved.error
      this.emit()
      return
    }
    const unchanged = this.pending === copy
    this.acknowledge(copy)
    this.error = null
    const now = saved.value.draft
    this.recovered ||= saved.value.recovered
    const current = now ?? (await this.reopen())
    if (current === null) return this.emit()
    this.draft = current
    if (unchanged) this.text = shown(current)
    this.emit()
    if (this.pending !== null || this.dirty) this.schedule(0)
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
    const copy = this.pending ?? (this.dirty ? this.keep(text) : null)
    const sending = { saved: text === shown(from) && copy === null, copy }
    this.cancelTimer()
    this.held = true
    this.sending = sending
    if (this.pending === copy) this.pending = null
    this.text = ""
    this.emit()
    return this.enqueue(async () => {
      let saved = from
      if (!sending.saved) {
        const result = await this.request(copy!)
        if (!result.ok || result.value.recovered || result.value.draft === null) {
          if (!result.ok) this.error = result.error
          return this.giveBack(text, result.ok ? (result.value.draft ?? from) : from)
        }
        saved = result.value.draft
        this.acknowledge(copy!)
        sending.saved = true
      }
      const outcome = await run(text, saved)
      if (!outcome.sent) return this.giveBack(text, saved)
      const next = this.text
      this.held = false
      this.sending = null
      const after = outcome.draft ?? (await this.reopen())
      if (after !== null && after.session !== saved.session) this.draft = after
      else if (after !== null && next === "") {
        // Not committed: another tab typed on before the send arrived. Its text shows.
        this.draft = after
        this.text = shown(after)
      }
      // Otherwise what's typed since goes on top of that tab's text, theirs one step back.
      else this.draft = saved
      if (this.pending !== null || this.dirty) this.schedule(SAVE_DELAY_MS)
      this.emit()
    })
  }

  /** The text of a send that didn't go, back in the box ahead of what's typed since, on `draft`. */
  private giveBack(text: string, draft: Draft) {
    const next = this.text
    this.held = false
    const sendingCopy = this.sending?.copy ?? null
    this.sending = null
    this.draft = draft
    this.text = next === "" ? text : `${text}\n\n${next}`
    this.emit()
    if (this.dirty) {
      this.keep(this.text)
      if (sendingCopy !== null) void dropCopy(sendingCopy)
      this.schedule(0)
    }
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
   * with the editors' (POST /library/drafts). While a send is out, that's its text if the
   * server hasn't confirmed it, and the next message (`next`): the server puts it in the
   * session the send ends, or on top of the text the send would take if it never arrives.
   * Past the browsers' 64 KB cap for such a request, only the copy in this browser keeps
   * the text.
   */
  beacon() {
    const draft = this.draft
    if (draft === null) return
    const sending = this.sending
    const saves = [
      ...(sending !== null && !sending.saved && sending.copy !== null ? [sending.copy] : []),
      ...(this.pending === null ? [] : [this.pending])
    ]
    const body = JSON.stringify({
      drafts: [],
      composers: saves.flatMap((copy) => {
        const save = pendingOf(copy)
        return save?.kind === "composer" ? [save.payload] : []
      })
    })
    if (saves.length === 0 || this.sent === body || new Blob([body]).size > KEEPALIVE_LIMIT) return
    for (const copy of saves) this.inFlight.add(copy)
    void fetch("/library/drafts", {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body
    }).then(
      (response) => {
        if (!response.ok) return
        this.sent = body
        // The browser copy is acknowledged; the live request still needs this identity
        // to reconcile its local draft with the writer's receipt.
        for (const copy of saves) void dropCopy(copy)
      },
      () => undefined
    )
  }
}
