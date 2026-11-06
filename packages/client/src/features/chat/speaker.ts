// The composer’s Guidance mode, speaker and next-reply pick (DESIGN §2.2), kept on the
// server with the composer’s draft (`ComposerChoice`), one per fork, so a reload,
// another tab or another device finds the same choice, never a reset to the first card
// (ST-GRIPES D8). A change made in any tab is published to every tab of the chat.
//
// One store per open chat, so the composer and the Cast tab read and change the same choice.
import type { EntityId } from "@rp/shared/chat.ts"
import type { ComposerChoice } from "@rp/shared/composerApi.ts"
import { useSyncExternalStore } from "react"
import { focusComposer } from "./composerFocus.ts"
import type { ChatSession, Outcome } from "./session.ts"

export interface ChoiceState {
  /** The composer draft the choice is kept with; null while the composer opens. */
  readonly draftId: string | null
  /** Whether the choice for `draftId` has been read: until then, nothing is sent. */
  readonly loaded: boolean
  readonly saving: boolean
  readonly guidance: boolean
  /** The card picked to speak as; null: none picked, so the composer's default. */
  readonly speaker: EntityId | null
  /** Who replies to the next send, picked for that one reply; null: the next in turn. */
  readonly replyFrom: EntityId | null
}

type Change = { readonly guidance?: boolean; readonly speaker?: EntityId | null; readonly replyFrom?: EntityId | null }

/** How long a choice that couldn't be read waits before it's read again. */
const RETRY_MS = 2000

class ComposerChoices {
  private state: ChoiceState = {
    draftId: null,
    loaded: false,
    saving: false,
    speaker: null,
    replyFrom: null,
    guidance: false
  }
  private readonly listeners = new Set<() => void>()
  /** Bumped by each read and change, so an older read's answer is dropped. */
  private reads = 0
  /** Changes on their way: a published choice that arrives meanwhile is older than them. */
  private writing = 0
  private writes: Promise<unknown> = Promise.resolve()
  /** A speaker picked before the composer's draft was known ("Write as" as the chat opens). */
  private early: EntityId | null = null

  private readonly session: ChatSession

  constructor(session: ChatSession) {
    this.session = session
    session.onComposerChoice((choice) => (choice === null ? void this.read() : this.receive(choice)))
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly snapshot = (): ChoiceState => this.state

  private setState(next: ChoiceState) {
    this.state = next
    for (const listener of this.listeners) listener()
  }

  /** The composer shows `draftId` now (null while it goes to another tip). */
  bind(draftId: string | null, guidance = false) {
    if (draftId === this.state.draftId) return
    this.reads++
    this.setState({ draftId, loaded: false, saving: false, speaker: null, replyFrom: null, guidance })
    if (draftId !== null) void this.read()
  }

  private async read() {
    const { draftId } = this.state
    if (draftId === null || this.writing > 0) return
    const reads = ++this.reads
    const result = await this.session.call((client) =>
      client("GetComposerChoice", { chatId: this.session.id, draftId })
    )
    if (reads !== this.reads || draftId !== this.state.draftId) return
    if (!result.ok && result.error.tag !== "NotFound") {
      setTimeout(() => {
        if (reads === this.reads) void this.read()
      }, RETRY_MS)
      return
    }
    const choice = result.ok ? result.value : null
    this.setState({
      draftId,
      loaded: true,
      saving: false,
      speaker: choice?.speakerEntityId ?? null,
      replyFrom: choice?.replyFromEntityId ?? null,
      guidance: choice?.guidance ?? false
    })
    if (this.early !== null) {
      const speaker = this.early
      this.early = null
      void this.change({ speaker })
    }
  }

  private receive(choice: ComposerChoice) {
    if (choice.draftId !== this.state.draftId || this.writing > 0) return
    this.reads++
    this.setState({
      ...this.state,
      loaded: true,
      saving: false,
      speaker: choice.speakerEntityId,
      replyFrom: choice.replyFromEntityId,
      guidance: choice.guidance
    })
  }

  /** Clears the pick used by a send, on the draft it came from, without clearing a newer pick. */
  consume(draftId: string, replyFrom: EntityId): Promise<Outcome<unknown>> {
    return this.session.call((client) =>
      client("SetComposerChoice", { chatId: this.session.id, draftId, consumeReplyFromEntityId: replyFrom })
    )
  }

  /** Keeps the choice on the server, which tells the chat's other tabs. */
  async change(change: Change): Promise<Outcome<unknown>> {
    const { draftId } = this.state
    if (draftId === null || (!this.state.loaded && change.guidance === undefined)) {
      if (change.speaker !== undefined) this.early = change.speaker
      return { ok: true, value: null }
    }
    this.reads++
    this.writing++
    this.setState({
      ...this.state,
      saving: this.state.saving || change.guidance === undefined,
      guidance: change.guidance ?? this.state.guidance
    })
    // Rapid picks leave in click order. Keep the acknowledged choice visible and block a
    // send until it is saved, so a failed pick can't produce a wrong-persona message.
    const request = this.writes.then(() =>
      this.session.call((client) =>
        client("SetComposerChoice", {
          chatId: this.session.id,
          draftId,
          ...(change.guidance === undefined ? {} : { guidance: change.guidance }),
          ...(change.speaker === undefined ? {} : { speakerEntityId: change.speaker }),
          ...(change.replyFrom === undefined ? {} : { replyFromEntityId: change.replyFrom })
        })
      )
    )
    this.writes = request
    const result = await request
    this.writing--
    if (this.writing === 0) {
      // Read again even after success: a different tab's newer event may have arrived
      // while writing. Also loads a different draft bound during this request.
      await this.read()
    }
    return result
  }
}

const stores = new WeakMap<ChatSession, ComposerChoices>()

export const composerChoice = (session: ChatSession): ComposerChoices => {
  let store = stores.get(session)
  if (store === undefined) {
    store = new ComposerChoices(session)
    stores.set(session, store)
  }
  return store
}

/** The speaker and reply choice of this chat's composer, as kept on the server. */
export const useComposerChoice = (session: ChatSession): ChoiceState => {
  const store = composerChoice(session)
  return useSyncExternalStore(store.subscribe, store.snapshot)
}

/** Makes `id` the composer's speaker and puts the cursor in the composer ("Write as"). */
export const writeAs = (session: ChatSession, id: EntityId) => {
  void composerChoice(session).change({ speaker: id })
  focusComposer({ preventScroll: true })
}
