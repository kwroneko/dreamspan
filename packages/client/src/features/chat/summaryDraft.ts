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
  private draft: Draft | null = null
  /** Typed here and not saved yet. */
  private local: string | null = null
  /** The browser copy of `local`. */
  private pending: Copy | null = null
  /** Copies on their way to the server, which a newer one mustn't replace. */
  private readonly sending = new Set<Copy>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
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
    if (result.ok) this.draft = result.value
    let error = result.ok ? null : result.error
    let restored = 0
    let displaced = this.view.displaced
    // Text that never reached the server, oldest first: each goes on top of the draft as it
    // was typed, and a newer one from another tab stays one step back in its history.
    const copies = [...(await copiesOf(this.userId, this.summary.id))].sort((a, b) => a.at - b.at)
    for (const copy of copies) {
      const save = pendingOf(copy)
      if (save?.kind !== "summary") continue
      this.sending.add(copy)
      const replayed = await this.session.call((client) => client("SaveSummaryDraft", save.payload))
      this.sending.delete(copy)
      restored++
      if (replayed.ok) {
        if (this.local === null) this.draft = replayed.value
        displaced = replayed.value.displaced?.content ?? displaced
        void dropCopy(copy)
      } else {
        // Still not on the server: the box shows it, and the copy stays until it is.
        if (this.pending !== null && this.pending.at < copy.at) this.pending = null
        if (this.pending === null) {
          this.local = copy.content
          this.pending = copy
        }
        error = replayed.error
      }
    }
    if (this.disposed) return
    this.refresh({ loading: false, error, restored, displaced })
  }

  /** The save of `content` as typed on the draft this tab has now. */
  private payload(content: string) {
    const base = this.draft
    return {
      summaryId: this.summary.id,
      draftId: base?.id ?? null,
      content,
      expectedRowVersion: base?.rowVersion ?? null,
      expectedSession: base?.session ?? null,
      baseRevisionId: base?.baseRevision ? (base.baseRevision as LcmSummary["revisionId"]) : this.summary.revisionId
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
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.save(), SAVE_DELAY_MS)
  }

  /** Saves what was typed now. Saves run one at a time. */
  async save(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    while (this.inFlight) await this.inFlight
    const sent = this.local
    if (sent === null) return
    const payload = this.payload(sent)
    const copy = this.pending
    const run = async () => {
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
      this.draft = result.value
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
    }
    this.inFlight = run()
    await this.inFlight
    this.inFlight = null
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
    this.refresh({ error: null })
  }

  /** Saves the text as a revision of the summary, selected; ends the draft. */
  async commit(): Promise<Outcome<unknown>> {
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
    if (result.ok) {
      this.draft = null
      this.local = null
      this.forget()
      this.refresh({ error: null, recovered: this.view.recovered + result.value.recovered })
    } else this.refresh({ error: result.error })
    return result
  }

  /** Ends the edit unsaved; its text goes to the bin's recovered texts. */
  async discard(): Promise<Outcome<unknown>> {
    await this.flush()
    const draft = this.draft
    if (draft === null || draft.status !== "active") {
      this.local = null
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
      this.local = null
      this.forget()
      this.refresh({ error: null, recovered: this.view.recovered + result.value.recovered })
    } else this.refresh({ error: result.error })
    return result
  }

  dispose() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
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
