// Composer work outlives its mounted surface, like the session's message editors.
// A fork-scoped surface may remount while a send/save is in flight. Its replacement
// must keep the same draft queue, source composer for branching, and operation status.
import { DraftWriter } from "./draftWriter.ts"
import type { AppError } from "../../errors.ts"
import { ComposerDraft } from "./composerDraft.ts"
import type { ChatSession } from "./session.ts"

class ComposerWorkspace {
  readonly draft: ComposerDraft
  readonly writing: DraftWriter
  private state: { busy: boolean; error: AppError | null } = { busy: false, error: null }
  private readonly listeners = new Set<() => void>()
  private readonly session: ChatSession
  private location: string | null = null
  constructor(session: ChatSession, userId: string) {
    this.session = session
    this.draft = new ComposerDraft(session, userId)
    this.writing = new DraftWriter(session, this.draft)
  }
  /** A surface remount is still the same tip. A moved tip or new open generation reads again. */
  readonly syncFork = () => {
    const { loading, forkId, leafSlotId, opened } = this.session.snapshot()
    if (loading) return
    const location = JSON.stringify([forkId, leafSlotId, opened])
    if (this.location === location) return
    this.location = location
    this.draft.setFork(forkId, this.session.takeBranchStart(forkId))
  }
  readonly snapshot = () => this.state
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish() {
    for (const listener of this.listeners) listener()
  }
  readonly setBusy = (busy: boolean) => {
    this.state = { ...this.state, busy }
    this.publish()
  }
  readonly setError = (error: AppError | null) => {
    this.state = { ...this.state, error }
    this.publish()
  }
}
const workspaces = new WeakMap<ChatSession, ComposerWorkspace>()
export const composerWorkspace = (session: ChatSession, userId: string) => {
  let workspace = workspaces.get(session)
  if (!workspace) {
    workspace = new ComposerWorkspace(session, userId)
    workspaces.set(session, workspace)
  }
  return workspace
}
