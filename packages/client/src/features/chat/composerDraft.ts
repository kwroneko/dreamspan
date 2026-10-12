// The composer's text as a server draft (DESIGN §6.2): one per branch tip, saved while the
// user types, read back on a reload or another device, with its undo history on the server.
// It follows the editors' rules (features/editor/store.ts): a copy in this browser while a
// change isn't on the server (backup.ts), a keepalive send as the page closes, a warning
// before closing with a change unsent, and a save counts only once the server answers.
//
// The rules that keep it lossless are ARCHITECTURE §3.10's invariants. Here:
// - The box's text belongs to the draft it was typed into (`base`), which is kept apart from
//   the tip the chat view asks for: a draft moves with its tip when a message is appended
//   there, so every save names the draft (its id, row version and session), and the server
//   puts the text wherever that draft is now.
// - `base` is the draft as of a text this box showed or sent, never just a newer version:
//   it changes only together with the text, or when the server answers with exactly the
//   text this tab sent. So a save from here is typing on the draft only if the box's text
//   came from it; otherwise the server puts it on top of the other text, which stays.
// - A copy in this browser is deleted only once the server has acknowledged it, or when a
//   newer copy of the same draft, typed from its text, replaces it.
// Server calls run one at a time, in order.
import type { SlotId } from "@rp/shared/chat.ts"
import type { SendResult } from "@rp/shared/chatApi.ts"
import { Draft, type DraftState } from "@rp/shared/drafts.ts"
import type { AppError } from "../../errors.ts"
import {
  browserEnv,
  type Copy,
  copiesOfUser,
  dropCopy,
  keepCopy,
  makeCopy,
  type PageEnv,
  pendingOf
} from "../editor/backup.ts"
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
  /** Text typed in this chat's composers went to the bin's recovered texts since the page opened. */
  readonly recovered: boolean
  /** The last save that failed, until one succeeds. */
  readonly error: AppError | null
}

/** The draft a send takes its text from: its tip, and what commits it (chatApi.ts `composer`). */
export interface ComposerSource {
  readonly tip: SlotId | null
  readonly draftId: string
  readonly session: number
  readonly text: string
}

/** A send's outcome as the composer needs it: not sent, or the draft as the send left it. */
export type Sent =
  { readonly sent: false } | { readonly sent: true; readonly draft: SendResult["draft"]; readonly recovered: number }

/** What this browser's copies (backup.ts) file a chat's composer under. */
const COPIES = "composer:"
const copyTarget = (chatId: string) => `${COPIES}${chatId}`
/** The draft's text as the box would show it: an ended draft holds none. */
const shown = (draft: Draft | null) => (draft?.status === "active" ? draft.content : "")
const tipOf = (draft: Draft) => (draft.key.field === "" ? null : (draft.key.field as SlotId))

export class ComposerDraft {
  /** The tip the chat view shows, which the box is on its way to. */
  private requested: SlotId | null | undefined = undefined
  /** The draft the text in the box was typed into, as of a text this tab showed or sent. */
  private base: Draft | null = null
  private text = ""
  private ready = false
  private restored = false
  private recovered = false
  private error: AppError | null = null
  /** A send is on its way: the box holds the next message, saved once the send is answered. */
  private held = false
  /** The pending save of the send on its way, and whether the server has it. */
  private sending: { saved: boolean; readonly copy: Copy | null } | null = null
  /** This tab's copy of the box's text not sent to the server yet, for `base`. */
  private pending: Copy | null = null
  private readonly inFlight = new WeakSet<Copy>()
  private timer: unknown = null
  private queue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  private state: ComposerState = { text: "", ready: false, restored: false, recovered: false, error: null }

  private readonly session: ChatSession
  private readonly userId: string
  /** Text carried over from the card's page (composerCarry.ts), for an empty composer. */
  private carried: string
  private readonly env: PageEnv

  constructor(session: ChatSession, userId: string, carried: string, env: PageEnv = browserEnv) {
    this.session = session
    this.userId = userId
    this.carried = carried
    this.env = env
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

  /** The box holds text the server doesn't have on `base`. */
  private get unsaved() {
    return this.base !== null && (this.pending !== null || this.text !== shown(this.base))
  }

  /**
   * Keeps the box's text in this browser as a save, made as it was typed. The previous copy
   * goes only if it's of the same draft and not on its way to the server: this text was
   * typed from it, so it names the same base. Otherwise it names `base` (`rebase`: the
   * server confirmed the text this was typed from at `base`).
   */
  private keep(text: string, rebase = false, parents: ReadonlyArray<Copy> = []) {
    const draft = this.base
    if (draft === null) return null
    const previous = this.pending
    const replaces = previous !== null && previous.field === draft.id && !this.inFlight.has(previous)
    const before = replaces && !rebase ? pendingOf(previous) : null
    const typedOn =
      before?.kind === "composer"
        ? before.payload
        : { rowVersion: draft.rowVersion, session: draft.session, next: this.held }
    const copy = makeCopy(
      this.userId,
      copyTarget(this.chatId),
      draft.id,
      {
        kind: "composer",
        payload: {
          chatId: this.chatId,
          draftId: draft.id,
          rowVersion: typedOn.rowVersion,
          session: typedOn.session,
          next: typedOn.next === true,
          content: text
        }
      },
      this.env.now(),
      [...parents, ...(previous === null ? [] : [previous])]
    )
    this.pending = copy
    void keepCopy(copy, replaces ? previous : null)
    return copy
  }

  /** The server has `copy`: it goes from this browser. */
  private acknowledge(copy: Copy) {
    void dropCopy(copy)
    if (this.pending === copy) this.pending = null
  }

  /** `copy` didn't reach the server, and a newer copy of the same draft typed from it replaces it. */
  private superseded(copy: Copy) {
    if (this.pending?.ancestors.includes(copy.key)) void dropCopy(copy)
  }

  /** The base is `draft` now, with its text in the box. */
  private take(draft: Draft) {
    this.base = draft
    this.text = shown(draft)
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
    if (!appended || this.base === null) {
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
    const copyFrom = branch && this.base !== null ? { copyFrom: this.base.id } : {}
    const opened = await this.session.call((client) =>
      client("OpenComposer", { chatId: this.chatId, tipSlotId: tip, ...copyFrom })
    )
    // The chat view reports why a read failed. A chat or tip that's gone stays shut; anything
    // else (the connection, say) is tried again.
    if (!opened.ok) {
      if (opened.error.tag !== "NotFound") {
        this.env.setTimer(() => void this.enqueue(() => this.goTo(tip, branch)), RETRY_MS)
      }
      return
    }
    const draft = opened.value
    if (this.base !== null && draft.id === this.base.id) {
      // The draft came here itself: a message was appended at its tip, or the leaf went up
      // from a deleted message or back down onto a restored one. The text stays.
      this.newer(draft)
      if (this.requested === tip) this.ready = true
      this.emit()
      return
    }
    // Another composer: the text goes where it was typed first. A copy that couldn't be saved
    // stays in this browser, and comes back when that composer opens.
    await this.save()
    this.pending = null
    if (this.requested === tip) await this.show(tip, draft)
  }

  /** The tip's text in the box, with what this browser kept of it when a page closed. */
  private async show(tip: SlotId | null, opened: Draft) {
    this.error = null
    const { draft, restored, recovered, unsent } = await this.saveCopies(opened)
    this.take(draft)
    const save = unsent === null ? null : pendingOf(unsent)
    if (save?.kind === "composer") {
      // The box shows a copy the server doesn't have, typed on the draft as it was then.
      const { rowVersion, session } = save.payload
      this.base = new Draft({ ...draft, status: "active", content: unsent!.content, rowVersion, session })
      this.text = unsent!.content
      this.pending = unsent
    }
    this.restored = restored
    // Stays for the page: text that went to the recovered texts as the box left its draft
    // was lost there, and this is where the user still is.
    this.recovered ||= recovered
    if (this.requested !== tip) return
    if (this.carried !== "" && this.text === "") this.text = this.carried
    this.carried = ""
    this.ready = true
    this.emit()
    if (this.unsaved) this.schedule(0)
  }

  /**
   * Makes every save this browser kept for want of the server (a page closed first), any
   * chat's, and says what they did to `opened`: its text came back (`restored`), or went to
   * the recovered texts. A copy of `opened` that can't be saved now comes back as `unsent`.
   * A copy that fails stays, whatever the reason: only an acknowledgement removes it.
   */
  private async saveCopies(opened: Draft) {
    let draft = opened
    let restored = false
    let recovered = false
    let unsent: Copy | null = null
    // Another draft's copy only once it's stale: a tab still typing there makes its own saves.
    const now = this.env.now()
    const copies = (await copiesOfUser(this.userId)).filter(
      (copy) => copy.refId.startsWith(COPIES) && (copy.field === opened.id || now - copy.at > STALE_COPY_MS)
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
      const { chatId, draftId } = pending.payload
      const saved = await this.session.call((client) => client("SaveComposer", pending.payload))
      if (!saved.ok) {
        if (draftId === opened.id) unsent = copy
        continue
      }
      await dropCopy(copy)
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
   * A newer state of the base draft. A box with nothing unsaved takes its text; otherwise the
   * text stays, and its save goes on top of the newer text, which stays one step back in the
   * history (or, if the draft's text was sent meanwhile, the box's goes to the recovered texts).
   */
  private newer(draft: Draft) {
    if (this.held || this.base === null) return
    if (this.unsaved) return this.schedule(0)
    this.take(draft)
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
    if (this.timer !== null) this.env.clearTimer(this.timer)
    this.timer = null
  }

  private schedule(delay: number) {
    this.cancelTimer()
    this.timer = this.env.setTimer(() => {
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

  /** Saves the pending copy unchanged, with the base it was typed on. */
  private async save() {
    if (this.held || !this.unsaved) return
    const copy = this.pending ?? this.keep(this.text)!
    const sent = copy.content
    const saved = await this.request(copy)
    if (!saved.ok) {
      this.error = saved.error
      this.superseded(copy)
      this.emit()
      return
    }
    const unchanged = this.pending === copy
    this.acknowledge(copy)
    this.error = null
    this.recovered ||= saved.value.recovered
    const now = saved.value.draft ?? (await this.reopen())
    if (now !== null && shown(now) === sent) {
      // The draft holds this tab's text: it's the base now, and what's typed since was typed
      // from it.
      this.base = now
      if (this.pending !== null && !this.inFlight.has(this.pending)) this.keep(this.text, true)
    } else if (now !== null && unchanged) {
      // It holds another text: this one went to the recovered texts (its session ended), or
      // the server had it already and another tab typed on since. Nothing was typed here
      // since, so the box takes it.
      this.take(now)
    }
    // Otherwise what's typed here since goes on top of it.
    this.emit()
    if (this.unsaved) this.schedule(0)
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
   * there, naming that draft, its session and the text, so the server commits the draft
   * only if it still holds exactly that text (ARCHITECTURE §3.10). If it isn't sent, it comes
   * back to the box, ahead of anything typed since.
   */
  submit(run: (source: ComposerSource) => Promise<Sent>): Promise<void> {
    const from = this.base
    if (from === null || this.held) return Promise.resolve()
    const text = this.text
    const copy = this.pending ?? (text !== shown(from) ? this.keep(text) : null)
    const sending = { saved: copy === null, copy }
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
        if (!result.ok) {
          this.error = result.error
          return this.giveBack(text, from)
        }
        this.acknowledge(copy!)
        sending.saved = true
        if (result.value.recovered || result.value.draft === null) {
          // Its session ended meanwhile (sent from another tab): the text is in the recovered
          // texts, and the box says so rather than sending it from a draft it wasn't typed in.
          this.recovered ||= result.value.recovered
          return this.settleSend(result.value.draft ?? (await this.reopen()))
        }
        // A save the server had already made (this browser's copy, sent as a page closed)
        // answers with the draft as it is now, which may hold another tab's text since: the
        // send then names the text, which the draft no longer holds, and commits nothing.
        if (shown(result.value.draft) === text) saved = result.value.draft
      }
      const outcome = await run({ tip: tipOf(saved), draftId: saved.id, session: saved.session, text })
      if (!outcome.sent) return this.giveBack(text, saved)
      this.recovered ||= outcome.recovered > 0
      const after = outcome.draft
      if (after !== null && after.id === saved.id && after.session !== saved.session && shown(after) === "") {
        // Committed: the box holds the next message, typed into the session the send began.
        this.held = false
        this.sending = null
        this.base = after
        if (this.unsaved) this.schedule(SAVE_DELAY_MS)
        return this.emit()
      }
      // Not committed: another tab typed on before the send arrived.
      this.settleSend(after ?? (await this.reopen()))
    })
  }

  /**
   * A send that left its draft as it was: the box shows the draft's text if nothing was
   * typed since; otherwise what's typed goes on top of it, the other text one step back.
   */
  private settleSend(current: Draft | null) {
    this.held = false
    this.sending = null
    if (current !== null && this.pending === null && this.text === "") this.take(current)
    this.emit()
    if (this.unsaved) this.schedule(SAVE_DELAY_MS)
  }

  /** The text of a send that didn't go, back in the box ahead of what's typed since, on `draft`. */
  private giveBack(text: string, draft: Draft) {
    const next = this.text
    this.held = false
    const sendingCopy = this.sending?.copy ?? null
    this.sending = null
    this.base = draft
    this.text = next === "" ? text : `${text}\n\n${next}`
    this.emit()
    if (this.text !== shown(draft) || this.pending !== null) {
      this.keep(this.text, false, sendingCopy === null ? [] : [sendingCopy])
      if (sendingCopy !== null) void dropCopy(sendingCopy)
      this.schedule(0)
    }
  }

  // --- Undo from the server's history

  async history(): Promise<Outcome<ReadonlyArray<DraftState>>> {
    await this.flush()
    const draft = this.base
    if (draft === null) return { ok: true, value: [] }
    return this.session.call((client) =>
      client("ComposerHistory", { chatId: this.chatId, draftId: draft.id, limit: 50 })
    )
  }

  /**
   * Moves the text back to an earlier state, the one the user picked with the box showing
   * what it shows now; the restore is in the history too. It's made only over that text, on
   * the server: if the box changed before it could go (calls before it were still out), it
   * isn't made. Text typed while it's on its way stays in the box, saved on top of it.
   */
  restore(seq: number): Promise<Outcome<Draft> | null> {
    const picked = this.text
    this.cancelTimer()
    return this.enqueue(async () => {
      await this.save()
      const draft = this.base
      if (draft === null || this.held) return null
      if (this.unsaved) return { ok: false as const, error: this.error ?? NOT_SAVED }
      if (this.text !== picked) return { ok: false as const, error: CHANGED }
      const result = await this.session.call((client) =>
        client("RestoreComposer", { chatId: this.chatId, draftId: draft.id, seq, expectedRowVersion: draft.rowVersion })
      )
      if (result.ok) {
        this.recovered ||= result.value.recovered > 0
        if (!this.unsaved) this.take(result.value)
        this.emit()
        if (this.unsaved) this.schedule(0)
      }
      return result
    })
  }

  // --- Leaving

  /** Text not on the server yet. */
  isUnsaved() {
    return this.unsaved || (this.sending !== null && !this.sending.saved)
  }

  /**
   * As the page goes: what's typed and not saved yet, in a request that outlives the page,
   * with the editors' (POST /library/drafts). While a send is out, that's its text if the
   * server hasn't confirmed it, and the next message (`next`): the server puts it in the
   * session the send ends, or on top of the text the send would take if it never arrives.
   * Past the browsers' 64 KB cap for such a request, only the copy in this browser keeps
   * the text.
   */
  beacon() {
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
    if (saves.length === 0 || new Blob([body]).size > KEEPALIVE_LIMIT) return
    for (const copy of saves) this.inFlight.add(copy)
    void this.env.keepalive("/library/drafts", body).then((ok) => {
      if (!(typeof ok === "boolean" ? ok : ok.ok)) return
      if (typeof ok !== "boolean") {
        this.recovered ||= ok.recovered > 0
        this.emit()
      }
      // The browser copy is acknowledged; the live request still needs this identity
      // to reconcile its local draft with the writer's receipt.
      for (const copy of saves) void dropCopy(copy)
    })
  }
}

const NOT_SAVED: AppError = {
  tag: "NotSaved",
  message: "What's typed isn't on the server yet, so an earlier text can't replace it.",
  problems: [],
  reason: null
}

const CHANGED: AppError = {
  tag: "Changed",
  message: "The text changed before the earlier one could come back, so it didn't. Pick it again if you still want it.",
  problems: [],
  reason: null
}
