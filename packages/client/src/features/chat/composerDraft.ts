import { deletedSince } from "@dreamspan/shared/drafts.ts"
// The composer's text as a server draft (DESIGN §6.2): one per fork, saved while the
// user types, read back on a reload or another device, with its undo history on the server.
// It follows the editors' rules (features/editor/store.ts): a copy in this browser while a
// change isn't on the server (backup.ts), a keepalive send as the page closes, a warning
// before closing with a change unsent, and a save counts only once the server answers.
//
// The rules that keep it lossless are ARCHITECTURE §3.10's invariants. Here:
// - The box's text belongs to the draft it was typed into (`base`), which is kept apart from
//   the fork the chat view asks for: every save names the draft (its id, row version and
//   session), and the server puts the text on that draft.
// - `base` is the draft as of a text this box showed or sent, never just a newer version:
//   it changes only together with the text, or when the server answers with exactly the
//   text this tab sent. So a save from here is typing on the draft only if the box's text
//   came from it; otherwise the server puts it on top of the other text, which stays.
// - A copy in this browser is deleted only once the server has acknowledged it, or when a
//   newer copy of the same draft, typed from its text, replaces it.
// Server calls run one at a time, in order.
import type { ForkId } from "@dreamspan/shared/chat.ts"
import type { SendResult } from "@dreamspan/shared/chatApi.ts"
import { Draft, type DraftState } from "@dreamspan/shared/drafts.ts"
import type { ComposerBeacon } from "@dreamspan/shared/composerApi.ts"
import type { ReplayConflict } from "../editor/backup.ts"
import type { AppError } from "../../errors.ts"
import {
  browserEnv,
  type Copy,
  copiesOfUser,
  dropCopy,
  keepCopy,
  makeCopy,
  type PageEnv,
  pendingOf,
  replaceCopies
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
  readonly guidance: boolean
  /** The fork's text is loaded, so the box takes input. */
  readonly ready: boolean
  /** A replay displaced text saved elsewhere; kept until acknowledged or switched. */
  readonly conflict: ReplayConflict | null
  /** The last save that failed, until one succeeds. */
  readonly error: AppError | null
  /** The draft the box shows, once ready: its speaker and reply choice go with it (speaker.ts). */
  readonly draftId: string | null
}

/** The draft a send takes its text from: its fork, and what commits it (chatApi.ts `composer`). */
export interface ComposerSource {
  readonly fork: ForkId | null
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
type ComposerSave = typeof ComposerBeacon.Type

/**
 * Text typed into a composer after its chat was swept (its saving stopped), by that chat: the
 * save that files it (the swept chat's, under its own operation, so the server files it once),
 * kept in this browser as that save's copy until the server has it, so a reload or a closed
 * page loses nothing (the pagehide keepalive sends it; an opening composer replays it once
 * stale, as any other draft's copy). Carried into the fresh chat the tab opens in its place
 * (`carryLeftover`), or filed to the recovered texts once as the tab leaves (`fileLeftover`).
 */
export interface Leftover {
  readonly content: string
  readonly save: ComposerSave
  readonly copy: Copy
}
/**
 * By chat, then by composer: two panes showing the same swept chat each keep their own text,
 * under a copy and an operation of its own, so neither replaces the other's.
 */
const leftovers = new Map<string, Map<object, Leftover>>()
/** Text carried into a fresh chat's composer, by that chat: its box starts with it. */
const carried = new Map<string, ReadonlyArray<Leftover>>()

/** The texts typed after `chatId` was swept, in each composer showing it, taken. */
export const takeLeftover = (chatId: string): ReadonlyArray<Leftover> => {
  const all = [...(leftovers.get(chatId)?.values() ?? [])]
  leftovers.delete(chatId)
  return all
}

/**
 * The tab leaves the swept `chatId`: what was typed after the sweep, if anything, is sent once
 * to the swept chat, which the server files to the recovered texts. Its copy in this browser
 * goes only once the server has it.
 */
export const fileLeftover = (chatId: string, save: (payload: ComposerSave) => Promise<{ readonly ok: boolean }>) => {
  for (const left of takeLeftover(chatId))
    void save(left.save).then(
      (saved) => {
        if (saved.ok) void dropCopy(left.copy)
      },
      () => {}
    )
}

/** The tab opened `to` in place of the swept `from`: what was typed after the sweep goes there. */
export const carryLeftover = (from: string, to: string) => {
  const left = takeLeftover(from)
  if (left.length > 0) carried.set(to, [...(carried.get(to) ?? []), ...left])
}

const shown = (draft: Draft | null) => (draft?.status === "active" ? draft.content : "")
const forkOf = (draft: Draft) => (draft.key.field === "" ? null : (draft.key.field as ForkId))

export class ComposerDraft {
  /** The fork the chat view shows (null: the chat's current one), which the box is on its way to. */
  private requested: ForkId | null | undefined = undefined
  /** The draft the text in the box was typed into, as of a text this tab showed or sent. */
  private base: Draft | null = null
  private text = ""
  private ready = false
  private conflict: ReplayConflict | null = null
  private replayedAt: number | null = null
  private error: AppError | null = null
  /** A send is on its way: the box holds the next message, saved once the send is answered. */
  private held = false
  /** Its chat was swept: the save the server filed last, and nothing is saved from here on. */
  private stopped: ComposerSave | null = null
  /** The text that save filed. */
  private filed = ""
  /** The pending save of the send on its way, and whether the server has it. */
  private sending: { saved: boolean; readonly copy: Copy | null } | null = null
  /** This tab's copy of the box's text not sent to the server yet, for `base`. */
  private pending: Copy | null = null
  /** Copies on their way to the server, by how many requests carry them. */
  private readonly outgoing = new WeakMap<Copy, number>()
  private timer: unknown = null
  private queue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  private state: ComposerState = {
    text: "",
    guidance: false,
    ready: false,
    conflict: null,
    error: null,
    draftId: null
  }

  private readonly session: ChatSession
  private readonly userId: string
  private readonly env: PageEnv

  constructor(session: ChatSession, userId: string, env: PageEnv = browserEnv) {
    this.session = session
    this.userId = userId
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

  /** Attachments use the text composer's resolved draft, never open a second one. */
  draftIdFor(fork: ForkId | null): string | null {
    return this.ready && this.requested === fork ? (this.base?.id ?? null) : null
  }

  private emit() {
    const { text, ready, conflict, error } = this
    const draftId = ready ? (this.base?.id ?? null) : null
    this.state = {
      text,
      guidance: this.base?.guidance ?? false,
      ready,
      conflict,
      error,
      draftId
    }
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
    const replaces = previous !== null && previous.field === draft.id && !this.inFlight(previous)
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

  // --- The fork

  /**
   * The fork shown, as the chat view has it. `branch`: it's being started here, so its
   * composer starts as a copy. The same fork again (its tip moved: a message was appended,
   * or one deleted) reads its draft again with the box open, for text another tab typed.
   */
  setFork(fork: ForkId | null, branch: boolean) {
    if (fork !== this.requested) {
      this.requested = fork
      this.ready = false
      this.emit()
    } else if (this.base === null) return
    void this.enqueue(() => this.goTo(fork, branch))
  }

  private retryOpen(fork: ForkId | null, branch: boolean) {
    this.env.setTimer(() => void this.enqueue(() => this.goTo(fork, branch)), RETRY_MS)
  }

  private async goTo(fork: ForkId | null, branch: boolean): Promise<void> {
    if (this.requested !== fork) return
    // A send taken from the box before this step ran is answered first.
    if (this.held) return void this.enqueue(() => this.goTo(fork, branch))
    // A branch starts from the composer as the server has it, so what's typed is saved first.
    if (branch) await this.save()
    const copyFrom = branch && this.base !== null ? { copyFrom: this.base.id } : {}
    // This browser's copies as they were before the read: one gone by the time they're saved
    // was answered meanwhile (a closing page's keepalive), maybe after the read (`show`).
    const before = await copiesOfUser(this.userId)
    const opened = await this.session.call((client) =>
      client("OpenComposer", { chatId: this.chatId, forkId: fork, ...copyFrom })
    )
    // The chat view reports why a read failed. A chat or fork that's gone stays shut; anything
    // else (the connection, say) is tried again.
    if (!opened.ok) {
      if (opened.error.tag !== "NotFound") this.retryOpen(fork, branch)
      return
    }
    const draft = opened.value
    if (this.base !== null && draft.id === this.base.id) {
      // The same draft: the fork's tip moved, or the fork the view named is the current one
      // it had already. The text stays, unless it's another tab's newer text and nothing was typed here.
      this.newer(draft)
      if (this.requested === fork) this.ready = true
      this.emit()
      return
    }
    // Another composer: the text goes where it was typed first. A copy that couldn't be saved
    // stays in this browser, and comes back when that composer opens.
    await this.save()
    this.pending = null
    if (this.requested === fork) await this.show(fork, draft, before)
  }

  /** The fork's text in the box, with what this browser kept of it when a page closed. */
  private async show(fork: ForkId | null, opened: Draft, before: ReadonlyArray<Copy>) {
    this.error = null
    const { draft, conflict, unsent, answered } = await this.saveCopies(opened, before)
    if (this.requested !== fork) return
    if (answered && unsent === null) {
      // A copy of this draft was saved after the read, so the read may lack its text: the box
      // would show older text, and what's typed on it would go over the newer text as another
      // tab's. Read again: the server has it now.
      if (this.ready) {
        this.ready = false
        this.emit()
      }
      return this.showCorrected(fork, draft.id, conflict)
    }
    this.showDraft(draft, conflict, unsent)
  }

  private async showCorrected(fork: ForkId | null, draftId: string, conflict: ReplayConflict | null): Promise<void> {
    if (this.requested !== fork || this.ready) return
    const again = await this.session.call((client) => client("OpenComposer", { chatId: this.chatId, forkId: fork }))
    if (this.requested !== fork) return
    if (!again.ok) {
      if (again.error.tag !== "NotFound")
        this.env.setTimer(() => void this.enqueue(() => this.showCorrected(fork, draftId, conflict)), RETRY_MS)
      return
    }
    if (again.value.id !== draftId) return this.goTo(fork, false)
    this.showDraft(again.value, conflict, null)
  }

  private showDraft(draft: Draft, conflict: ReplayConflict | null, unsent: Copy | null) {
    this.take(draft)
    const save = unsent === null ? null : pendingOf(unsent)
    if (save?.kind === "composer") {
      // The box shows a copy the server doesn't have, typed on the draft as it was then.
      const { rowVersion, session } = save.payload
      this.base = new Draft({ ...draft, status: "active", content: unsent!.content, rowVersion, session })
      this.text = unsent!.content
      this.pending = unsent
    }
    this.replayedAt = unsent?.at ?? null
    this.conflict = conflict
    this.ready = true
    this.emit()
    // Opened in place of a swept chat: what was typed there after the sweep starts this box.
    const left = carried.get(this.chatId)
    carried.delete(this.chatId)
    if (left !== undefined) {
      this.type([this.text, ...left.map((one) => one.content)].filter((text) => text !== "").join("\n\n"))
      // This box's own copy holds it now: the swept chat's copies go in the same transaction
      // that keeps it, so a failed one keeps them, and they're replayed as any other copy.
      const mine = this.pending
      if (mine !== null)
        void replaceCopies(
          mine,
          left.map((one) => one.copy)
        )
    }
    if (this.unsaved) this.schedule(0)
  }

  /**
   * Makes every save this browser kept for want of the server (a page closed first), any
   * chat's, and says what they did to `opened`. Text that went to the recovered texts is
   * there without a word (DESIGN §6.2). A copy of `opened` that can't be saved now comes back
   * as `unsent`.
   * A copy that fails stays, whatever the reason: only an acknowledgement removes it.
   */
  private async saveCopies(opened: Draft, before: ReadonlyArray<Copy>) {
    let draft = opened
    let conflict: ReplayConflict | null = null
    let unsent: Copy | null = null
    // Another draft's copy only once it's stale: a tab still typing there makes its own saves.
    const now = this.env.now()
    // A pending page knows the new chat but not its draft yet. Keep its exact text
    // durable while opening, then replace it atomically with a replayable draft copy.
    for (const copy of await copiesOfUser(this.userId)) {
      const save = pendingOf(copy)
      if (save?.kind !== "pendingChat" || save.payload.chatId !== this.chatId) continue
      const original = save.payload.composerBase
      const base = original ?? { draftId: opened.id, rowVersion: opened.rowVersion, session: opened.session }
      // Unversioned legacy handoffs cannot prove they were typed after a known deletion.
      if (
        (!original || original.draftId === opened.id) &&
        deletedSince(opened, original ? { draftId: original.draftId, expectedRowVersion: original.rowVersion } : null)
      )
        continue
      const adopted = makeCopy(
        this.userId,
        copyTarget(this.chatId),
        base.draftId,
        {
          kind: "composer",
          payload: {
            chatId: this.chatId,
            draftId: base.draftId,
            rowVersion: base.rowVersion,
            session: base.session,
            next: false,
            content: copy.content
          }
        },
        copy.at,
        [copy]
      )
      await keepCopy(adopted, copy)
    }
    const kept = await copiesOfUser(this.userId)
    const keys = new Set(kept.map((copy) => copy.key))
    // A copy of `opened` that was here before the read and is gone now: its save was answered.
    const answered = before.some(
      (copy) => copy.refId.startsWith(COPIES) && copy.field === opened.id && !keys.has(copy.key)
    )
    const copies = kept.filter(
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
      const { draftId } = pending.payload
      const deleted =
        draftId === draft.id && deletedSince(draft, { draftId, expectedRowVersion: pending.payload.rowVersion })
      // The writer can acknowledge an already-applied clear by its receipt, or
      // recover stale text behind the deletion barrier. Only its reply drops the copy.
      const saved = await this.session.call((client) => client("SaveComposer", pending.payload))
      if (!saved.ok) {
        if (draftId === opened.id && !deleted) unsent = copy
        continue
      }
      await dropCopy(copy)
      const now = saved.value.draft
      if (now?.id === opened.id) {
        if (now.displaced !== null) conflict = { ...now.displaced, typedAt: copy.at }
        draft = now
      }
    }
    return { draft, conflict, unsent, answered }
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

  /** The fork the box is on, or on its way to. */
  get fork() {
    return this.requested
  }

  acknowledgeConflict() {
    this.conflict = null
    this.emit()
  }

  /** An explicit restore keeps the text it replaces as a separate undo step. */
  async switchConflict() {
    const conflict = this.conflict
    if (conflict === null) return
    const result = await this.restore(0, conflict.content)
    if (result !== null && !result.ok) {
      this.error = result.error
      this.emit()
    }
    if (result?.ok && !this.unsaved && this.text === conflict.content && this.conflict === conflict)
      this.acknowledgeConflict()
  }

  // --- Typing and saving

  type(text: string) {
    if (this.stopped !== null) {
      this.text = text
      this.remember()
      this.emit()
      return
    }
    this.text = text
    this.keep(text)
    this.emit()
    this.schedule(SAVE_DELAY_MS)
  }

  /** What's in the box past what the sweep filed, kept for the tab's fresh chat. */
  private remember() {
    const stopped = this.stopped
    if (stopped === null) return
    const mine = leftovers.get(this.chatId) ?? new Map<object, Leftover>()
    leftovers.set(this.chatId, mine)
    const previous = mine.get(this) ?? null
    // A copy of a save typed before the sweep was known (made while that save was out): its
    // text is this box's, kept from now on as the text typed after the sweep, or not at all.
    const stale = this.pending
    this.pending = null
    const replaced = [previous?.copy, stale].filter((copy) => copy != null)
    if (this.text.trim() === "" || this.text === this.filed) {
      mine.delete(this)
      if (mine.size === 0) leftovers.delete(this.chatId)
      for (const copy of replaced) void dropCopy(copy)
      return
    }
    // In this browser at once, under a save of its own: the text replaces the one kept before.
    const { operationId: _filed, ...base } = stopped
    const copy = makeCopy(
      this.userId,
      copyTarget(this.chatId),
      stopped.draftId,
      { kind: "composer", payload: { ...base, content: this.text } },
      this.env.now()
    )
    const save = pendingOf(copy)
    if (save?.kind !== "composer") return
    mine.set(this, { content: this.text, save: save.payload, copy })
    void replaceCopies(copy, replaced)
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
    this.send(copy)
    try {
      return await this.session.call((client) => client("SaveComposer", save.payload))
    } finally {
      this.arrived(copy)
    }
  }

  private send(copy: Copy) {
    this.outgoing.set(copy, (this.outgoing.get(copy) ?? 0) + 1)
  }

  private arrived(copy: Copy) {
    const left = (this.outgoing.get(copy) ?? 1) - 1
    if (left > 0) this.outgoing.set(copy, left)
    else this.outgoing.delete(copy)
  }

  private inFlight(copy: Copy) {
    return this.outgoing.has(copy)
  }

  /** Saves the pending copy unchanged, with the base it was typed on. */
  private async save() {
    if (this.held || !this.unsaved) return
    const copy = this.pending ?? this.keep(this.text)!
    await this.settle(copy, await this.request(copy))
  }

  /** What the server answered to a save of `copy`, for the box. */
  private async settle(copy: Copy, saved: Awaited<ReturnType<ComposerDraft["request"]>>) {
    const sent = copy.content
    if (!saved.ok) {
      this.error = saved.error
      this.superseded(copy)
      this.emit()
      return
    }
    const unchanged = this.pending === copy
    const descendant = this.pending?.ancestors.includes(copy.key) === true
    this.acknowledge(copy)
    this.error = null
    if (this.replayedAt !== null && saved.value.draft?.displaced != null)
      this.conflict = { ...saved.value.draft.displaced, typedAt: this.replayedAt }
    this.replayedAt = null
    if (!saved.value.accepted && saved.value.draft === null) {
      // Its chat is gone (a pending chat swept meanwhile): the server filed the text to the
      // recovered texts and there's no draft to save on. Nothing more is saved here; the page
      // opens a fresh chat in its place, and what's typed from now on goes with it.
      const save = pendingOf(copy)
      if (save?.kind === "composer") this.stopped = save.payload
      this.filed = sent
      this.base = null
      this.remember()
      this.emit()
      return
    }
    const now = saved.value.draft ?? (await this.reopen())
    if (saved.value.accepted && now !== null && shown(now) === sent && (unchanged || descendant)) {
      // The draft holds this tab's text: it's the base now, and what's typed since was typed
      // from it.
      this.base = now
      if (this.pending !== null && !this.inFlight(this.pending)) this.keep(this.text, true)
    } else if (now !== null && unchanged) {
      // It holds another text: this one went to the recovered texts (its session ended), or
      // the server had it already and another tab typed on since. Nothing was typed here
      // since, so the box takes it.
      this.take(now)
    }
    // Otherwise what's typed here since goes on top of it.
    this.emit()
    if (this.unsaved && now !== null) this.schedule(0)
  }

  /** The composer of the fork asked for, read again. */
  private async reopen() {
    const fork = this.requested
    if (fork === undefined) return null
    const opened = await this.session.call((client) => client("OpenComposer", { chatId: this.chatId, forkId: fork }))
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
        if (!result.value.accepted || result.value.recovered || result.value.draft === null) {
          // Its session ended meanwhile (sent from another tab): the text is in the recovered
          // texts unless it was sent already, rather than sent from a draft it wasn't typed in.
          return this.settleSend(result.value.draft ?? (await this.reopen()))
        }
        // A save the server had already made (this browser's copy, sent as a page closed)
        // answers with the draft as it is now, which may hold another tab's text since: the
        // send then names the text, which the draft no longer holds, and commits nothing.
        if (shown(result.value.draft) === text) saved = result.value.draft
      }
      const outcome = await run({ fork: forkOf(saved), draftId: saved.id, session: saved.session, text })
      if (!outcome.sent) return this.giveBack(text, saved)
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
  restore(seq: number, content?: string): Promise<Outcome<Draft> | null> {
    const picked = this.text
    this.cancelTimer()
    return this.enqueue(async () => {
      await this.save()
      const draft = this.base
      if (draft === null || this.held) return null
      if (this.unsaved) return { ok: false as const, error: this.error ?? NOT_SAVED }
      if (this.text !== picked) return { ok: false as const, error: CHANGED }
      const result = await this.session.call((client) =>
        client("RestoreComposer", {
          chatId: this.chatId,
          draftId: draft.id,
          seq,
          expectedRowVersion: draft.rowVersion,
          ...(content === undefined ? {} : { content })
        })
      )
      if (result.ok) {
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
    // Its chat was swept: what was typed since goes to the swept chat, which files it.
    if (this.stopped !== null) return this.beaconLeftover()
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
    for (const copy of saves) this.send(copy)
    void this.env.keepalive("/library/drafts", body).then((ok) => {
      for (const copy of saves) this.arrived(copy)
      if (!(typeof ok === "boolean" ? ok : ok.ok)) return
      // The browser copy is acknowledged; the live request still needs this identity
      // to reconcile its local draft with the writer's receipt.
      for (const copy of saves) void dropCopy(copy)
      // The page stayed (the back-forward cache kept it): the box learns the draft as the
      // server has it, by the same save again, which the writer answers from its receipt.
      // Otherwise what's typed next would name the draft as it was before, and be saved
      // over this text as another tab's.
      const pending = this.pending
      const mine =
        pending === null ? undefined : saves.find((copy) => copy === pending || pending.ancestors.includes(copy.key))
      if (mine !== undefined)
        void this.enqueue(async () => {
          const now = this.pending
          if (now === null || (now !== mine && !now.ancestors.includes(mine.key))) return
          await this.settle(mine, await this.request(mine))
        })
    })
  }

  /**
   * The text typed after the sweep, as the page goes: its save, which the server files to the
   * recovered texts once (by its operation). Answered, its copy here goes; the text stays
   * kept for the tab, in case the page stays (the back-forward cache), and a later send of it
   * files nothing more.
   */
  private beaconLeftover() {
    const left = leftovers.get(this.chatId)?.get(this)
    if (left === undefined) return
    const body = JSON.stringify({ drafts: [], composers: [left.save] })
    if (new Blob([body]).size > KEEPALIVE_LIMIT) return
    void this.env.keepalive("/library/drafts", body).then((ok) => {
      if (typeof ok === "boolean" ? ok : ok.ok) void dropCopy(left.copy)
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
