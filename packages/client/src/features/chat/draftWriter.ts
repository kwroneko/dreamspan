import { Effect, Stream } from "effect"
import type { DraftGenerationTarget } from "@rp/shared/generationTarget.ts"
import type { ChatSession } from "./session.ts"
import type { ComposerDraft } from "./composerDraft.ts"

interface DraftWritingState {
  readonly running: boolean
  readonly rolloutId: string | null
  readonly error: string | null
  readonly undo: boolean
}

/** Paragraph separation preserves every byte already in the composer. */
export const draftSeparator = (text: string) =>
  text === "" || /\n\s*\n$/.test(text) ? "" : /\n$/.test(text) ? "\n" : "\n\n"

export class DraftWriter {
  private state: DraftWritingState = { running: false, rolloutId: null, error: null, undo: false }
  private readonly listeners = new Set<() => void>()
  private active: { target: DraftGenerationTarget; before: string; expected: string; cancel: () => void } | null = null
  private undoText: { draftId: string; text: string } | null = null
  private readonly session: ChatSession
  private readonly draft: ComposerDraft
  constructor(session: ChatSession, draft: ComposerDraft) {
    this.session = session
    this.draft = draft
  }
  readonly snapshot = () => this.state
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<DraftWritingState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  readonly stop = () => {
    const active = this.active
    if (active === null) return
    this.active = null
    active?.cancel()
    this.update({ running: false })
    void this.draft.flush()
  }
  readonly submitted = () => {
    this.stop()
    this.undoText = null
    this.update({ undo: false })
  }
  readonly undo = () => {
    this.stop()
    if (this.undoText?.draftId === this.draft.snapshot().draftId) {
      this.draft.type(this.undoText.text)
      void this.draft.flush()
    }
    this.undoText = null
    this.update({ undo: false })
  }
  /** Reopening a composer still finds the saved request independently of messages. */
  readonly load = async () => {
    const forkId = this.session.snapshot().forkId
    if (!forkId || this.active) return
    const result = await this.session.call((api) => api("GetLastDraftRollout", { chatId: this.session.id, forkId }))
    if (this.session.snapshot().forkId === forkId && !this.active)
      this.update({
        rolloutId: result.ok ? result.value : null,
        error: null,
        undo: this.undoText?.draftId === this.draft.snapshot().draftId
      })
  }
  readonly start = async () => {
    if (this.active || !this.draft.snapshot().ready) return
    const view = this.session.snapshot()
    const opened = this.draft.snapshot()
    if (!view.forkId || !opened.draftId) return
    const target: DraftGenerationTarget = {
      kind: "draft",
      chatId: this.session.id,
      forkId: view.forkId,
      leafSlotId: view.leafSlotId,
      draftId: opened.draftId
    }
    let cancel = () => {}
    const stopped = new Promise<void>((resolve) => {
      cancel = resolve
    })
    const active = { target, before: opened.text, expected: opened.text, cancel }
    this.active = active
    this.update({ running: true, rolloutId: null, error: null, undo: false })
    const changed = () => {
      const current = this.session.snapshot()
      const draft = this.draft.snapshot()
      if (
        current.loading ||
        current.forkId !== target.forkId ||
        current.leafSlotId !== target.leafSlotId ||
        draft.draftId !== target.draftId ||
        draft.text !== active.expected
      )
        this.stop()
    }
    const stopView = this.session.subscribe(changed)
    const stopDraft = this.draft.subscribe(changed)
    // Save the starting text before any generated append. All chunks use the same draft queue.
    await this.draft.flush()
    if (this.active !== active) {
      stopView()
      stopDraft()
      return
    }
    let added = false
    const result = await this.session.call((api) =>
      api("WriteForMe", { target }).pipe(
        Stream.interruptWhen(Effect.promise(() => stopped)),
        Stream.runForEach(({ rolloutId, text }) =>
          Effect.sync(() => {
            if (this.active !== active) return
            this.update({ rolloutId })
            if (text === "") return
            if (!added) {
              this.undoText = { draftId: target.draftId, text: active.before }
              this.update({ undo: true })
            }
            active.expected += (added ? "" : draftSeparator(active.expected)) + text
            added = true
            this.draft.type(active.expected)
          })
        )
      )
    )
    stopView()
    stopDraft()
    if (this.active === active) {
      this.active = null
      this.update({ running: false, error: result.ok ? null : result.error.message })
    }
    await this.draft.flush()
  }
}
