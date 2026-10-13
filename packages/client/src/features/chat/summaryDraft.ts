// The text of a summary being edited (ARCHITECTURE §3.10, §16): typed into a server draft
// that keeps its undo history, and saved as a revision only when the user says so. The
// rules are the other fields': the draft a save names is the one this tab last saw
// (id, row version, session), it changes only together with the text shown or when the
// server answered a save with exactly the text sent, and a save never waits on another.
//
// Unlike the library's fields, no copy of unsent text is kept in this browser yet: text
// that never reached the server is only in the box until it does.
import type { Draft } from "@rp/shared/drafts.ts"
import type { LcmSummary } from "@rp/shared/lcm.ts"
import type { AppError } from "../../errors.ts"
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
    error: null,
    displaced: null,
    outdated: false,
    recovered: 0
  }
  private readonly listeners = new Set<() => void>()
  private draft: Draft | null = null
  /** Typed here and not saved yet. */
  private local: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private summary: LcmSummary
  private disposed = false
  private readonly session: ChatSession

  constructor(session: ChatSession, summary: LcmSummary) {
    this.session = session
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
    this.refresh({ loading: false, error: result.ok ? null : result.error })
  }

  setText(text: string) {
    this.local = text
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
    const base = this.draft
    const run = async () => {
      const result = await this.session.call((client) =>
        client("SaveSummaryDraft", {
          summaryId: this.summary.id,
          draftId: base?.id ?? null,
          content: sent,
          expectedRowVersion: base?.rowVersion ?? null,
          expectedSession: base?.session ?? null,
          baseRevisionId: base?.baseRevision ? (base.baseRevision as LcmSummary["revisionId"]) : this.summary.revisionId
        })
      )
      if (this.disposed) return
      if (!result.ok) return this.refresh({ error: result.error })
      this.draft = result.value
      // More typed since: it goes on top of this save, on the draft as the server now has it.
      if (this.local === sent) this.local = null
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
