// Private non-secret text drafts. Explicit Save stays separate from saving the draft.
import { useEffect, useMemo, useSyncExternalStore } from "react"
import type { UserId } from "@rp/shared/domain.ts"
import type { Draft, DraftState } from "@rp/shared/drafts.ts"
import { useAction } from "../../actions.tsx"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { copiesOf, dropCopy, keepCopy, makeCopy, pendingOf, type Copy } from "./backup.ts"

type Run = ReturnType<typeof useAction>["run"]
class UserDraftStore {
  private draft: Draft | null = null
  private copy: Copy | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private listeners = new Set<() => void>()
  private state = {
    text: null as string | null,
    ready: false,
    error: null as string | null,
    history: null as ReadonlyArray<DraftState> | null
  }
  private userId: UserId
  private targetId: string
  private field: string
  private run: Run
  constructor(userId: UserId, targetId: string, field: string, run: Run) {
    this.userId = userId
    this.targetId = targetId
    this.field = field
    this.run = run
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = () => this.state
  private update(change: Partial<typeof this.state>) {
    this.state = { ...this.state, ...change }
    this.listeners.forEach((listener) => listener())
  }
  private address = () => ({ ownerId: this.userId, targetId: this.targetId, field: this.field })
  private payload = (content: string) => ({
    ...this.address(),
    content,
    draftId: this.draft?.id ?? null,
    expectedRowVersion: this.draft?.rowVersion ?? null,
    expectedSession: this.draft?.session ?? null
  })
  private remember(content: string, current: boolean) {
    const previous = current ? this.copy : null
    const copy = makeCopy(
      this.userId,
      this.targetId,
      this.field,
      { kind: "userDraft", payload: this.payload(content) },
      current ? Date.now() : (this.copy?.at ?? Date.now()) - 1,
      previous ? [previous] : []
    )
    if (current) this.copy = copy
    return { copy, kept: keepCopy(copy, previous) }
  }
  private async persist(content: string) {
    // Refile on our own preceding acknowledgement, never a fresh read of another tab's base.
    const { copy, kept } = this.remember(content, content === this.state.text)
    await kept
    const result = await this.run((client) =>
      client("SaveUserDraft", copy.save.kind === "userDraft" ? copy.save.payload : this.payload(content))
    )
    if (!result.ok) {
      this.update({ error: result.error.message })
      return false
    }
    this.draft = result.value
    if (this.copy === copy) this.copy = null
    await dropCopy(copy)
    this.update({ error: result.value.displaced ? "Another edit was kept in field undo history." : null })
    return true
  }
  open = () => {
    this.queue = this.queue.then(async () => {
      const [result, copies] = await Promise.all([
        this.run((client) => client("GetUserDraft", this.address())),
        copiesOf(this.userId, this.targetId)
      ])
      if (result.ok) this.draft = result.value
      else this.update({ error: result.error.message })
      for (const copy of copies
        .filter((c) => c.field === this.field || (this.field === "First message" && c.field === "first message"))
        .sort((a, b) => a.at - b.at)) {
        const save = pendingOf(copy)
        if (save?.kind === "setting" || save?.kind === "pendingChat") {
          // The old pending composer also retains a carry copy: an existing server draft takes precedence.
          if (save.kind === "pendingChat" && this.draft !== null) continue
          const replay = await this.run((client) =>
            client("SaveUserDraft", {
              ...this.address(),
              content: save.payload.content,
              draftId: null,
              expectedRowVersion: null,
              expectedSession: null
            })
          )
          if (replay.ok) {
            this.draft = replay.value
            await dropCopy(copy)
          } else this.update({ error: replay.error.message, text: this.state.text ?? copy.content })
          continue
        }
        if (save?.kind !== "userDraft") continue
        const replay = await this.run((client) => client("SaveUserDraft", save.payload))
        if (replay.ok) {
          this.draft = replay.value
          await dropCopy(copy)
        } else this.update({ error: replay.error.message, text: this.state.text ?? copy.content })
      }
      this.update({
        ready: true,
        text: this.state.text ?? (this.draft?.status === "active" ? this.draft.content : null)
      })
    })
  }
  leave = () => {
    const copy = this.copy
    if (copy?.save.kind === "userDraft")
      void fetch("/library/drafts", {
        method: "POST",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ drafts: [], userDrafts: [copy.save.payload] })
      }).catch(() => {})
  }
  type = (content: string, saved: string) => {
    const initial = this.state.text ?? saved
    this.update({ text: content, history: null })
    void this.remember(content, true).kept
    this.queue = this.queue.then(async () => {
      if (this.draft === null || this.draft.status !== "active") {
        if (!(await this.persist(initial))) return
      }
      await this.persist(content)
    })
  }
  /** The save takes only its submitted text. Later keystrokes stay queued and backed up. */
  commit = (content: string, save: () => Promise<boolean>, outcome: "committed" | "discarded" = "committed") => {
    const operation = this.queue.then(async () => {
      if (!(await this.persist(content))) return false
      const draft = this.draft!
      if (!(await save())) return false
      const ended = await this.run((client) =>
        client("EndUserDraft", {
          ...this.address(),
          draftId: draft.id,
          expectedRowVersion: draft.rowVersion,
          outcome
        })
      )
      if (ended.ok) this.draft = ended.value
      this.update({
        text: this.state.text === content ? null : this.state.text,
        error: ended.ok ? null : ended.error.message,
        history: null
      })
      return true
    })
    this.queue = operation
    return operation
  }
  history = () => {
    this.queue = this.queue.then(async () => {
      if (!this.draft) {
        this.update({ history: [] })
        return
      }
      const result = await this.run((client) => client("UserDraftHistory", this.address()))
      if (result.ok) this.update({ history: result.value })
      else this.update({ error: result.error.message })
    })
  }
  restore = (seq: number) => {
    const typed = this.state.text
    this.queue = this.queue.then(async () => {
      if (!this.draft) return
      const result = await this.run((client) =>
        client("RestoreUserDraft", {
          ...this.address(),
          draftId: this.draft!.id,
          expectedRowVersion: this.draft!.rowVersion,
          seq
        })
      )
      if (result.ok) {
        this.draft = result.value
        if (this.state.text === typed) this.update({ text: result.value.content, history: null })
      } else this.update({ error: result.error.message })
    })
  }
  undo = () => {
    const typed = this.state.text
    this.queue = this.queue.then(async () => {
      if (!this.draft) return
      const history = await this.run((client) => client("UserDraftHistory", this.address()))
      if (!history.ok) {
        this.update({ error: history.error.message })
        return
      }
      const previous = history.value[1]
      if (!previous) return
      const result = await this.run((client) =>
        client("RestoreUserDraft", {
          ...this.address(),
          draftId: this.draft!.id,
          expectedRowVersion: this.draft!.rowVersion,
          seq: previous.seq
        })
      )
      if (result.ok) {
        this.draft = result.value
        if (this.state.text === typed) this.update({ text: result.value.content })
      } else this.update({ error: result.error.message })
    })
  }
}

export function useUserDraft(targetId: string, field: string, saved: string) {
  const { run } = useAction()
  const userId = useSession().user.id
  // The transport and queued writes outlive this editor; identity changes make a new store.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const store = useMemo(() => new UserDraftStore(userId, targetId, field, run), [userId, targetId, field])
  const state = useSyncExternalStore(store.subscribe, store.snapshot)
  useEffect(() => {
    store.open()
    window.addEventListener("pagehide", store.leave)
    return () => {
      window.removeEventListener("pagehide", store.leave)
      store.leave()
    }
  }, [store])
  return {
    ...state,
    text: state.text ?? saved,
    setText: (text: string) => store.type(text, saved),
    commit: store.commit,
    discard: (save: () => Promise<boolean> = async () => true) => store.commit(state.text ?? saved, save, "discarded"),
    undo: store.undo,
    showHistory: store.history,
    restore: store.restore
  }
}

export function UserDraftStatus({ draft }: { draft: ReturnType<typeof useUserDraft> }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
      <Button variant="ghost" disabled={!draft.ready} onClick={draft.undo}>
        Undo field change
      </Button>
      <Button variant="ghost" disabled={!draft.ready} onClick={draft.showHistory}>
        Field undo history
      </Button>
      {draft.history && (
        <ul aria-label="Field undo history" className="max-h-64 w-full overflow-auto">
          {draft.history.map((entry) => (
            <li key={entry.seq}>
              <Button variant="ghost" onClick={() => draft.restore(entry.seq)}>
                {entry.kind === "initial" ? "Starting text" : new Date(entry.at).toLocaleString()} ({entry.length}{" "}
                characters) {entry.inserted}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <span>{draft.error ?? "Draft and field undo are kept on the server."}</span>
    </div>
  )
}
