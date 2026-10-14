// The text of a summary being edited (ARCHITECTURE §3.10, §16): typed into a server draft
// that keeps its undo history, and saved as a revision only when the user says so. The
// rules are the other fields': the draft a save names is the one this tab last saw
// (id, row version, session), it changes only together with the text shown or when the
// server answered a save with exactly the text sent, and a save never waits on another.
//
// As in the library's fields, text typed is copied into this browser (`editor/backup.ts`)
// until the server has it: a save that fails, a closed tab or panel, or a reload leaves the
// copy, which opening the edit again replays, with the base it was typed on.
import type { Draft } from "@rp/shared/drafts.ts"
import type { LcmSummary } from "@rp/shared/lcm.ts"
import type { AppError } from "../../errors.ts"
import { type Copy, copiesOf, dropCopy, keepCopy, makeCopy, pendingOf } from "../editor/backup.ts"
import type { ChatSession, Outcome } from "./session.ts"

/** How long typing pauses before the text is saved. */
const SAVE_DELAY_MS = 600

export interface SummaryDraftView {
  readonly loading: boolean
  /** What the box shows. */
  readonly text: string
  /** The text differs from the revision being edited. */
  readonly changed: boolean
  /** Typed text not on the server yet. */
  readonly unsaved: boolean
  /** How many copies kept in this browser opening the edit sent to the server. */
  readonly restored: number
  readonly error: AppError | null
  /** Another tab's text this tab's save went over: kept one step back in the history. */
  readonly displaced: string | null
  /** The draft started from an older revision than the one now selected. */
  readonly outdated: boolean
  /** How many earlier texts committing or discarding sent to the recovered texts. */
  readonly recovered: number
}

/** What the text a save sends was typed on (§3.10, "a field's base"): the draft and revision as the tab had them. */
interface Base {
  readonly draftId: string | null
  readonly rowVersion: number | null
  readonly session: number | null
  /** The revision the text started from; null: the one being edited now. */
  readonly revisionId: LcmSummary["revisionId"] | null
}
const baseOf = (draft: Draft | null): Base => ({
  draftId: draft?.id ?? null,
  rowVersion: draft?.rowVersion ?? null,
  session: draft?.session ?? null,
  revisionId: draft?.baseRevision ? (draft.baseRevision as LcmSummary["revisionId"]) : null
})

export class SummaryDraft {
  private view: SummaryDraftView = {
    loading: true,
    text: "",
    changed: false,
    unsaved: false,
    restored: 0,
    error: null,
    displaced: null,
    outdated: false,
    recovered: 0
  }
  private readonly listeners = new Set<() => void>()
  /** The draft as the server last answered with it. */
  private draft: Draft | null = null
  /**
   * What the text shown was typed on, which its saves name. It changes only with the text
   * shown, or when the server answers with exactly the text sent: text restored from a copy
   * keeps the copy's base until the server has it, whatever the server holds now.
   */
  private base: Base = baseOf(null)
  /** Typed here and not saved yet. */
  private local: string | null = null
  /** The browser copy of `local`. */
  private pending: Copy | null = null
  /** Copies on their way to the server, which a newer one mustn't replace. */
  private readonly sending = new Set<Copy>()
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Replays and saves run one at a time, in order. */
  private queue: Promise<unknown> = Promise.resolve()
  private summary: LcmSummary
  private disposed = false
  private readonly session: ChatSession
  private readonly userId: string

  constructor(session: ChatSession, userId: string, summary: LcmSummary) {
    this.session = session
    this.userId = userId
    this.summary = summary
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  readonly snapshot = () => this.view

  private set(change: Partial<SummaryDraftView>) {
    this.view = { ...this.view, ...change }
    for (const listener of this.listeners) listener()
  }

  private serial<A>(task: () => Promise<A>): Promise<A> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  private cancelTimer() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  /** The text shown: what's typed, else the draft, else the revision. */
  private shown() {
    return this.local ?? (this.draft?.status === "active" ? this.draft.content : (this.summary.content ?? ""))
  }

  private refresh(extra: Partial<SummaryDraftView> = {}) {
    const text = this.shown()
    this.set({
      text,
      changed: text !== (this.summary.content ?? ""),
      unsaved: this.local !== null,
      outdated: this.draft?.status === "active" && this.draft.baseRevision !== this.summary.revisionId,
      ...extra
    })
  }

  /** The summary moved on (another revision selected, another tab): the box keeps what the user has. */
  update(summary: LcmSummary) {
    this.summary = summary
    this.refresh()
  }

  async open() {
    const result = await this.session.call((client) => client("GetSummaryDraft", { summaryId: this.summary.id }))
    if (this.disposed) return
    if (result.ok) {
      this.draft = result.value
      if (this.local === null) this.base = baseOf(result.value)
    }
    // Text that never reached the server, oldest first: each goes on top of the draft as it
    // was typed, and a newer one from another tab stays one step back in its history.
    const copies = [...(await copiesOf(this.userId, this.summary.id))].sort((a, b) => a.at - b.at)
    await this.serial(async () => {
      let error = result.ok ? null : result.error
      let restored = 0
      let displaced = this.view.displaced
      for (const copy of copies) {
        const save = pendingOf(copy)
        if (save?.kind !== "summary") continue
        this.sending.add(copy)
        const replayed = await this.session.call((client) => client("SaveSummaryDraft", save.payload))
        this.sending.delete(copy)
        restored++
        if (replayed.ok) {
          this.draft = replayed.value
          if (this.local === null) this.base = baseOf(replayed.value)
          displaced = replayed.value.displaced?.content ?? displaced
          void dropCopy(copy)
        } else {
          // Still not on the server: the box shows it, on the base it was typed on, and the
          // copy stays until the server has it.
          if (this.pending !== null && this.pending.at < copy.at) this.pending = null
          if (this.pending === null) {
            this.local = copy.content
            this.pending = copy
            this.base = {
              draftId: save.payload.draftId,
              rowVersion: save.payload.expectedRowVersion,
              session: save.payload.expectedSession,
              revisionId: save.payload.baseRevisionId
            }
          }
          error = replayed.error
        }
      }
      if (this.disposed) return
      this.refresh({ loading: false, error, restored, displaced })
    })
  }

  /** The save of `content` as typed on the base of the text shown. */
  private payload(content: string) {
    const base = this.base
    return {
      summaryId: this.summary.id,
      draftId: base.draftId,
      content,
      expectedRowVersion: base.rowVersion,
      expectedSession: base.session,
      baseRevisionId: base.revisionId ?? this.summary.revisionId
    }
  }

  /** Copies `content` into this browser, in place of the last copy unless that one is being sent. */
  private keep(content: string) {
    const previous = this.pending
    const replaces = previous !== null && !this.sending.has(previous)
    const copy = makeCopy(
      this.userId,
      this.summary.id,
      "summary",
      { kind: "summary", payload: this.payload(content) },
      Date.now(),
      previous === null ? [] : [previous]
    )
    this.pending = copy
    void keepCopy(copy, replaces ? previous : null)
  }

  /** The copy, once the text it holds is on the server or thrown away on purpose. */
  private forget() {
    if (this.pending !== null) void dropCopy(this.pending)
    this.pending = null
  }

  setText(text: string) {
    this.local = text
    this.keep(text)
    this.refresh()
    this.cancelTimer()
    this.timer = setTimeout(() => void this.save(), SAVE_DELAY_MS)
  }

  /** Saves what was typed now. Saves run one at a time, after a replay. */
  save(): Promise<void> {
    this.cancelTimer()
    return this.serial(async () => {
      const sent = this.local
      if (sent === null) return
      const payload = this.payload(sent)
      const copy = this.pending
      if (copy !== null) this.sending.add(copy)
      const result = await this.session.call((client) => client("SaveSummaryDraft", payload))
      if (copy !== null) this.sending.delete(copy)
      // The copies are settled even once the edit is closed: that's when they matter most.
      if (!result.ok) {
        // A newer copy, typed from this one, has everything this one has.
        if (copy !== null && this.pending !== copy && this.pending?.ancestors.includes(copy.key)) void dropCopy(copy)
        if (!this.disposed) this.refresh({ error: result.error })
        return
      }
      // The server has exactly the text sent: what's typed from it is on the draft as it is now.
      this.draft = result.value
      this.base = baseOf(result.value)
      if (copy !== null) void dropCopy(copy)
      if (this.local === sent) {
        this.local = null
        if (this.pending === copy) this.pending = null
      } else if (this.local !== null && this.pending !== null && !this.sending.has(this.pending)) {
        // More typed since: its copy now names the draft as the server has it.
        this.keep(this.local)
      }
      if (this.disposed) return
      this.refresh({
        error: null,
        recovered: this.view.recovered + result.value.recovered,
        displaced: result.value.displaced?.content ?? this.view.displaced
      })
    })
  }

  /** Everything typed, on the server. */
  async flush() {
    await this.save()
    while (this.local !== null && this.view.error === null) await this.save()
  }

  /** One step back in the draft's history. */
  async undo(): Promise<void> {
    await this.flush()
    if (this.view.unsaved || this.draft === null) return
    const states = await this.session.call((client) =>
      client("SummaryDraftHistory", { summaryId: this.summary.id, limit: 2 })
    )
    if (!states.ok) return this.refresh({ error: states.error })
    const previous = states.value[1]
    if (previous === undefined) return
    const result = await this.session.call((client) =>
      client("RestoreSummaryDraft", {
        summaryId: this.summary.id,
        draftId: this.draft!.id,
        seq: previous.seq,
        expectedRowVersion: this.draft!.rowVersion
      })
    )
    if (!result.ok) return this.refresh({ error: result.error })
    this.draft = result.value
    if (this.local === null) this.base = baseOf(result.value)
    this.refresh({ error: null })
  }

  /**
   * Saves the text as a revision of the summary, selected; ends the draft. Whether the edit
   * is done: text typed while the revision was being saved stays in the box, with its copy
   * and its pending save, typed on the new revision.
   */
  async commit(): Promise<Outcome<{ readonly done: boolean }>> {
    await this.flush()
    if (this.local !== null) return { ok: false, error: this.view.error ?? notSaved }
    const draft = this.draft
    const content = this.shown()
    const result = await this.session.call((client) =>
      client("EditSummary", {
        summaryId: this.summary.id,
        content,
        expectedRowVersion: this.summary.rowVersion,
        commitDraft: draft?.status === "active" ? { draftId: draft.id, session: draft.session } : null
      })
    )
    if (!result.ok) {
      this.refresh({ error: result.error })
      return result
    }
    const recovered = this.view.recovered + result.value.recovered
    const now = this.shown()
    // The draft holding the text committed is ended; one holding text typed since isn't.
    if (this.draft?.content === content) this.draft = null
    if (now !== content) {
      if (this.local !== null) {
        // Typed from the text the server now has as a revision: its copy names that revision.
        this.base = { ...this.base, revisionId: result.value.summary.revisionId }
        if (this.pending !== null && !this.sending.has(this.pending)) this.keep(this.local)
      }
      this.refresh({ error: null, recovered })
      return { ok: true, value: { done: false } }
    }
    this.draft = null
    this.cancelTimer()
    this.local = null
    this.forget()
    this.base = baseOf(null)
    this.refresh({ error: null, recovered })
    return { ok: true, value: { done: true } }
  }

  /**
   * Ends the edit unsaved; its text goes to the bin's recovered texts. Text the server
   * doesn't have yet has nowhere to go: the edit stays open, with its copy.
   */
  async discard(): Promise<Outcome<unknown>> {
    await this.flush()
    if (this.local !== null) return { ok: false, error: this.view.error ?? notSaved }
    const draft = this.draft
    if (draft === null || draft.status !== "active") {
      this.forget()
      this.refresh({ error: null })
      return { ok: true, value: null }
    }
    const result = await this.session.call((client) =>
      client("DiscardSummaryDraft", {
        summaryId: this.summary.id,
        draftId: draft.id,
        expectedRowVersion: draft.rowVersion
      })
    )
    if (result.ok) {
      this.draft = null
      this.base = baseOf(null)
      this.forget()
      this.refresh({ error: null, recovered: this.view.recovered + result.value.recovered })
    } else this.refresh({ error: result.error })
    return result
  }

  dispose() {
    this.cancelTimer()
    // A change not on the server yet is sent on the way out.
    void this.save()
    this.disposed = true
  }
}

const notSaved: AppError = {
  tag: "NotSaved",
  message: "A change isn't on the server yet. Wait for it to be kept, then try again.",
  problems: [],
  reason: null
}
