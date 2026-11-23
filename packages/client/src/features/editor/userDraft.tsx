import { Tooltip } from "../../ui/Tooltip.tsx"
import {
  mapEditingOrigin,
  editingOrigin,
  reconcileDeletedFields,
  reconcileForm
} from "@dreamspan/shared/draftDeletions.ts"
// Private non-secret text drafts. Explicit Save stays separate from saving the draft.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import type { UserId } from "@dreamspan/shared/domain.ts"
import {
  type EditingOrigin,
  observeDeletion,
  type ObservedDeletion,
  deletedSince,
  type Draft,
  type DraftDisplacement,
  type DraftState
} from "@dreamspan/shared/drafts.ts"
import type { UserDraftSave } from "@dreamspan/shared/editorApi.ts"
import { useAction } from "../../actions.tsx"
import { useSession } from "../../session.ts"
import { userNoticeReceivers } from "../noticeContributions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { iconButtonClass } from "../../ui/Tooltip.tsx"
import { chromeButton } from "../../ui/FieldFrame.tsx"
import { copiesOf, dropCopy, keepCopy, makeCopy, pendingOf, type Copy } from "./backup.ts"

import { readTypedBackup, keepTypedBackup, dropTypedBackup } from "./typedBackup.ts"

const openStores = new Set<UserDraftStore>()
export const registerUserDraftNotices = () =>
  userNoticeReceivers.register({
    id: "editor.user-drafts",
    receive: (notice) => {
      for (const store of openStores) {
        if (notice._tag === "UserDraftSync") store.refresh()
        else if (notice._tag === "UserDraftChanged") store.receive(notice.draft)
      }
    }
  })

type Run = ReturnType<typeof useAction>["run"]
type Base = Pick<typeof UserDraftSave.Type, "draftId" | "expectedRowVersion" | "expectedSession">
const baseOf = (draft: Draft | null): Base => ({
  draftId: draft?.id ?? null,
  expectedRowVersion: draft?.rowVersion ?? null,
  expectedSession: draft?.session ?? null
})
/**
 * Which text a page opens with when the server's draft and a copy kept in this browser differ:
 * the one written last. A reload right after typing can read the server before the last
 * keystrokes' saves reach it; the browser's copy has them. Equal times keep the server's.
 */
export const newerText = (serverAt: number | null, localAt: number | null): "server" | "local" =>
  localAt !== null && (serverAt === null || localAt > serverAt) ? "local" : "server"

export class UserDraftStore {
  private draft: Draft | null = null
  // The base of the displayed text, independent of reads/restores the user hasn't seen.
  private observedDeletion: ObservedDeletion | null = null
  private base = baseOf(null)
  private editingFrom: EditingOrigin | null = null
  private lastPersistAcknowledged = false
  private edits = 0
  private acknowledgedEdit = -1
  private pendingTypes = new Set<{
    initial: string
    content: string
    editingFrom: EditingOrigin | null
    edit: number
  }>()
  private copy: Copy | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private listeners = new Set<() => void>()
  private state = {
    text: null as string | null,
    ready: false,
    error: null as string | null,
    history: null as ReadonlyArray<DraftState> | null,
    displaced: null as DraftDisplacement | null,
    recovered: 0,
    remote: null as Draft | null,
    /** When the server's draft, as opened, was last written: its text against a newer browser copy. */
    savedAt: null as number | null
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
  private payload = (content: string, seed = false, editingFrom = this.editingFrom) => ({
    ...this.address(),
    content,
    ...(seed ? { seed: true } : {}),
    ...(editingFrom === null ? {} : { editingFrom }),
    ...(this.observedDeletion === null ? {} : { observedDeletion: this.observedDeletion }),
    ...this.base
  })
  private remember(content: string, current: boolean, seed = false, editingFrom = this.editingFrom) {
    const previous = current ? this.copy : null
    const copy = makeCopy(
      this.userId,
      this.targetId,
      this.field,
      { kind: "userDraft", payload: this.payload(content, seed, editingFrom) },
      current ? Date.now() : (this.copy?.at ?? Date.now()) - 1,
      previous ? [previous] : []
    )
    if (current) {
      this.copy = copy
      keepTypedBackup(copy)
    }
    return { copy, kept: keepCopy(copy, previous) }
  }
  private async persist(content: string, seed = false, editingFrom = this.editingFrom, edit = this.edits) {
    // A repeated Save of an acknowledged edit is not a new clear of remote typing.
    if (!seed && edit <= this.acknowledgedEdit) editingFrom = content
    this.lastPersistAcknowledged = false
    // Refile on our own preceding acknowledgement, never a fresh read of another tab's base.
    const { copy, kept } = this.remember(
      content,
      !seed && edit === this.edits && content === this.state.text,
      seed,
      editingFrom
    )
    await kept
    const result = await this.run((client) =>
      client("SaveUserDraft", copy.save.kind === "userDraft" ? copy.save.payload : this.payload(content, seed))
    )
    if (!result.ok) {
      this.update({ error: result.error.message })
      return false
    }
    this.lastPersistAcknowledged = true
    this.draft = result.value
    // A deletion may have won while this request was in flight. Recovery acknowledges
    // the copy into the bin, not as new field text; never rebase later typing onto it unseen.
    const accepted = result.value.status === "active" && result.value.content === content
    const showing = edit === this.edits && this.state.text === content
    if (accepted || showing) {
      this.base = baseOf(result.value)
      this.editingFrom = result.value.status === "active" ? result.value.content : null
      if (accepted) {
        if (!seed) this.acknowledgedEdit = Math.max(this.acknowledgedEdit, edit)
        // Replay actual later transitions onto this exact acknowledgement. An earlier
        // response cannot erase a later clear, or carry an acknowledged clear forward.
        for (const pending of this.pendingTypes) {
          if (pending.edit < edit || (!seed && pending.edit === edit)) continue
          this.editingFrom = editingOrigin(this.editingFrom, pending.initial, pending.content, pending.editingFrom)
          pending.editingFrom = this.editingFrom
        }
      }
      this.observedDeletion = null
    }
    if (!accepted && showing) this.update({ text: result.value.status === "active" ? result.value.content : null })
    if (this.copy === copy) this.copy = null
    dropTypedBackup(copy)
    await dropCopy(copy)
    // Later typing is descended from this acknowledged text. Refile its browser copy
    // now, even if another queued operation delays its own save or the page closes.
    if (accepted && this.copy !== null && this.state.text !== null) await this.remember(this.state.text, true).kept
    this.update({
      error: accepted
        ? null
        : deletedSince(result.value, copy.save.kind === "userDraft" ? copy.save.payload : null) ||
            reconcileDeletedFields(result.value, copy.save.kind === "userDraft" ? copy.save.payload : null, content)
              .changed
          ? "This text was deleted elsewhere. Find your copy in recovered texts."
          : "This text changed elsewhere. Review the updated text.",
      displaced: result.value.displaced ?? this.state.displaced,
      recovered: this.state.recovered + result.value.recovered
    })
    return accepted
  }
  open = () => {
    this.queue = this.queue.then(async () => {
      const [result, copies] = await Promise.all([
        this.run((client) => client("GetUserDraft", this.address())),
        copiesOf(this.userId, this.targetId)
      ])
      if (result.ok) {
        this.draft = result.value
        if (this.edits === 0) {
          this.base = baseOf(result.value)
          this.editingFrom = result.value?.status === "active" ? result.value.content : null
        } else if (
          result.value !== null &&
          this.base.draftId === null &&
          this.pendingTypes.size > 0 &&
          (result.value.status !== "active" || [...this.pendingTypes][0]?.initial === result.value.content)
        ) {
          // Typing began in the host's empty/saved field before its draft read finished.
          // The read confirms that starting text; this is new typing, not an offline replay.
          this.observedDeletion = observeDeletion(result.value)
          if (this.copy !== null && this.state.text !== null) await this.remember(this.state.text, true).kept
        }
      } else this.update({ error: result.error.message })
      const sync = readTypedBackup(this.userId, this.targetId)
      const allCopies = sync === null || copies.some((copy) => copy.key === sync.key) ? copies : [...copies, sync]
      for (const copy of allCopies
        .filter((c) => !this.copy?.ancestors.includes(c.key))
        .filter((c) => c.field === this.field || (this.field === "First message" && c.field === "first message"))
        .sort((a, b) => a.at - b.at)) {
        const save = pendingOf(copy)
        // A deletion is a causal barrier, even if the server now holds subsequent text.
        // Leave the asynchronous copy in Browser recovery for explicit inspection.
        if (deletedSince(this.draft, save?.kind === "userDraft" ? save.payload : null)) {
          await keepCopy(copy)
          dropTypedBackup(copy)
          continue
        }
        const copyBase = save?.kind === "userDraft" ? save.payload : null
        const formCopy =
          this.draft === null
            ? null
            : reconcileForm(
                this.draft,
                copyBase,
                copy.content,
                copyBase?.editingFrom,
                save?.kind !== "userDraft" || save.payload.seed !== true
              )
        const safeCopy =
          this.draft === null
            ? { content: copy.content, changed: false, rejected: false }
            : reconcileDeletedFields(
                this.draft,
                save?.kind === "userDraft" && save.payload.seed !== true ? save.payload : null,
                formCopy?.content ?? copy.content
              )
        const copiedFormChanged = safeCopy.changed || formCopy?.changed === true
        if (safeCopy.rejected) {
          await keepCopy(copy)
          dropTypedBackup(copy)
          continue
        }
        if (save?.kind === "setting" || save?.kind === "pendingChat") {
          // The pending composer keeps its own copy of each keystroke too. An existing server
          // draft takes precedence unless that copy is newer: the server can lag the last
          // keystrokes when the page reloads right after them (newerText above).
          if (
            save.kind === "pendingChat" &&
            this.draft !== null &&
            newerText(this.draft.updatedAt, copy.at) === "server"
          )
            continue
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
            if (this.edits === 0) {
              this.base = baseOf(replay.value)
              this.editingFrom = replay.value.status === "active" ? replay.value.content : null
              this.copy = null
              this.update({ text: replay.value.status === "active" ? replay.value.content : null })
            }
            this.update({
              displaced: replay.value.displaced ?? this.state.displaced,
              recovered: this.state.recovered + replay.value.recovered
            })
            dropTypedBackup(copy)
            await dropCopy(copy)
          } else {
            if (this.edits === 0) {
              // Legacy copies have no draft identity: their replay and any continuation
              // must keep the null base, rather than adopting the opening read unseen.
              this.base = baseOf(null)
              this.copy = copiedFormChanged ? null : copy
              this.editingFrom = safeCopy.content
              if (safeCopy.changed) this.observedDeletion = observeDeletion(this.draft)
              this.update({ text: safeCopy.content })
            }
            this.update({ error: replay.error.message })
          }
          continue
        }
        if (save?.kind !== "userDraft") continue
        if (copy.key.startsWith("legacy:") && newerText(this.draft?.updatedAt ?? null, copy.at) === "server") continue
        const replay = await this.run((client) => client("SaveUserDraft", save.payload))
        if (replay.ok) {
          this.draft = replay.value
          if (this.edits === 0) {
            this.base = baseOf(replay.value)
            this.editingFrom = replay.value.status === "active" ? replay.value.content : null
            this.copy = null
            this.update({ text: replay.value.status === "active" ? replay.value.content : null })
          }
          this.update({
            displaced: replay.value.displaced ?? this.state.displaced,
            recovered: this.state.recovered + replay.value.recovered
          })
          dropTypedBackup(copy)
          await dropCopy(copy)
        } else {
          if (this.edits === 0) {
            this.observedDeletion = save.payload.observedDeletion ?? null
            this.base = {
              draftId: save.payload.draftId,
              expectedRowVersion: save.payload.expectedRowVersion,
              expectedSession: save.payload.expectedSession
            }
            this.copy = copiedFormChanged ? null : copy
            this.editingFrom = save.payload.editingFrom ?? formCopy?.intent ?? safeCopy.content
            if (safeCopy.changed && this.draft !== null) {
              this.editingFrom = mapEditingOrigin(
                this.editingFrom,
                (content) => reconcileDeletedFields(this.draft!, save.payload, content).content
              )
              this.observedDeletion = observeDeletion(this.draft)
            }
            this.update({ text: safeCopy.content })
          }
          this.update({ error: replay.error.message })
        }
      }
      this.update({
        ready: true,
        savedAt: this.draft?.updatedAt ?? null,
        text: this.state.text ?? (this.draft?.status === "active" ? this.draft.content : null)
      })
    })
  }
  connect = () => {
    openStores.add(this)
    return () => {
      openStores.delete(this)
    }
  }
  private applyRemote(draft: Draft | null) {
    if (draft === null) return
    if (draft.key.targetId !== this.targetId || draft.key.field !== this.field) return
    if (draft.id === this.base.draftId && draft.rowVersion <= (this.base.expectedRowVersion ?? 0)) return
    if (this.state.remote?.id === draft.id && draft.rowVersion <= this.state.remote.rowVersion) return
    // A queued or refused write still belongs to the text the user actually saw.
    // Ended rows contain empty storage, not the saved setting/form. The host's
    // saved value may be stale too, so offer a reload instead of showing either.
    if (draft.status !== "active" || this.copy !== null || this.pendingTypes.size > 0) {
      this.update({ remote: draft, history: null })
      return
    }
    this.draft = draft
    this.base = baseOf(draft)
    this.editingFrom = draft.status === "active" ? draft.content : null
    this.update({ text: draft.status === "active" ? draft.content : null, remote: null, history: null })
  }
  receive = (draft: Draft) => {
    this.queue = this.queue.then(() => this.applyRemote(draft))
  }
  refresh = () => {
    this.queue = this.queue.then(async () => {
      const result = await this.run((client) => client("GetUserDraft", this.address()))
      if (result.ok) this.applyRemote(result.value)
      else this.update({ error: result.error.message })
    })
  }
  resolveRemote = (load: boolean) => {
    const operation = this.queue.then(async () => {
      const remote = this.state.remote
      if (!remote) return false
      const edits = this.edits
      // Keeping text is an explicit choice after observing the remote deletion. The
      // observation never replaces the original text base. Loading may acknowledge
      // local text into recovered texts instead of reopening a deleted field.
      if (!load) this.observedDeletion = observeDeletion(remote)
      if (this.state.text !== null && !(await this.persist(this.state.text)) && !this.lastPersistAcknowledged)
        return false
      if (this.edits !== edits) return false
      if (load) {
        if (remote.status !== "active") {
          // Reloading alone would reopen the local text just persisted. Discard that
          // exact version into recovered texts first; never pass empty storage to a
          // JSON form or use its stale saved-value prop as a new active draft.
          if (this.state.text === null) {
            this.draft = remote
            this.base = baseOf(remote)
          }
          if (this.draft?.status === "active") {
            const ended = await this.run((client) =>
              client("EndUserDraft", {
                ...this.address(),
                draftId: this.draft!.id,
                expectedRowVersion: this.draft!.rowVersion,
                outcome: "discarded"
              })
            )
            if (!ended.ok) {
              this.update({ error: ended.error.message })
              return false
            }
            this.draft = ended.value
            this.base = baseOf(ended.value)
            this.update({ recovered: this.state.recovered + ended.value.recovered })
            if (this.copy !== null && this.state.text !== null) await this.remember(this.state.text, true).kept
          }
          if (this.edits !== edits) return false
          this.update({ text: null, remote: null })
          return true
        }
        this.update({ text: remote.content })
        // This is an explicit choice of the observed remote version. Saving on that base
        // keeps the local text as a displaced history step, even for similar prose.
        this.base = baseOf(remote)
        this.editingFrom = remote.content
        await this.remember(remote.content, true).kept
        if (!(await this.persist(remote.content))) return false
      }
      this.update({ remote: null })
      return false
    })
    this.queue = operation
    return operation
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
    this.editingFrom = editingOrigin(this.editingFrom, initial, content)
    this.edits++
    this.update({ text: content, history: null })
    void this.remember(content, true).kept
    const pending = { initial, content, editingFrom: this.editingFrom, edit: this.edits }
    this.pendingTypes.add(pending)
    this.queue = this.queue.then(async () => {
      try {
        if (pending.edit <= this.acknowledgedEdit) return
        if (this.draft === null || this.draft.status !== "active") {
          if (!(await this.persist(pending.initial, true, pending.initial, pending.edit))) return
        }
        await this.persist(pending.content, false, pending.editingFrom, pending.edit)
      } finally {
        this.pendingTypes.delete(pending)
      }
    })
  }
  /** The save takes only its submitted text. Later keystrokes stay queued and backed up. */
  commit = (
    content: string,
    save: () => Promise<boolean>,
    outcome: "committed" | "discarded" = "committed",
    rebase?: (text: string) => string
  ) => {
    const edit = this.edits
    const editingFrom = this.editingFrom
    const operation = this.queue.then(async () => {
      if (!(await this.persist(content, false, editingFrom, edit))) return false
      const draft = this.draft!
      if (!(await save())) return false
      // Only this form's acknowledged Save can advance the settings version in later
      // snapshots. Keep it in the durable text too, so a reload can save the next edit.
      if (rebase) {
        for (const pending of this.pendingTypes) {
          pending.initial = rebase(pending.initial)
          pending.content = rebase(pending.content)
          if (pending.editingFrom !== null) pending.editingFrom = mapEditingOrigin(pending.editingFrom, rebase)
        }
        if (this.editingFrom !== null) this.editingFrom = mapEditingOrigin(this.editingFrom, rebase)
        if (this.state.text !== null && this.state.text !== content) {
          this.update({ text: rebase(this.state.text) })
          await this.remember(this.state.text!, true).kept
        }
      }
      const ended = await this.run((client) =>
        client("EndUserDraft", {
          ...this.address(),
          draftId: draft.id,
          expectedRowVersion: draft.rowVersion,
          outcome
        })
      )
      if (ended.ok) {
        this.draft = ended.value
        this.base = baseOf(ended.value)
        if (this.copy !== null && this.state.text !== null) await this.remember(this.state.text, true).kept
      }
      if (this.state.text === content) this.editingFrom = null
      this.update({
        text: this.state.text === content ? null : this.state.text,
        error: ended.ok ? null : ended.error.message,
        recovered: this.state.recovered + (ended.ok ? ended.value.recovered : 0),
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
    const edits = this.edits
    this.queue = this.queue.then(async () => {
      if (this.copy !== null && this.state.text !== null && !(await this.persist(this.state.text))) return
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
        this.update({ error: null, recovered: this.state.recovered + result.value.recovered })
        if (this.edits === edits) {
          this.base = baseOf(result.value)
          this.editingFrom = result.value.content
          this.update({ text: result.value.content, history: null })
        }
      } else this.update({ error: result.error.message })
    })
  }
  undo = () => {
    const edits = this.edits
    this.queue = this.queue.then(async () => {
      if (this.copy !== null && this.state.text !== null && !(await this.persist(this.state.text))) return
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
        this.update({ error: null, recovered: this.state.recovered + result.value.recovered })
        if (this.edits === edits) {
          this.base = baseOf(result.value)
          this.editingFrom = result.value.content
          this.update({ text: result.value.content })
        }
      } else this.update({ error: result.error.message })
    })
  }
  acknowledge = () => this.update({ displaced: null })
}

export function useUserDraft(targetId: string, field: string, saved: string) {
  const { run } = useAction()
  const userId = useSession().user.id
  // The transport and queued writes outlive this editor; identity changes make a new store.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const store = useMemo(() => new UserDraftStore(userId, targetId, field, run), [userId, targetId, field])
  const state = useSyncExternalStore(store.subscribe, store.snapshot)
  useEffect(() => {
    const disconnect = store.connect()
    store.open()
    window.addEventListener("pagehide", store.leave)
    return () => {
      disconnect()
      window.removeEventListener("pagehide", store.leave)
      store.leave()
    }
  }, [store])
  return {
    ...state,
    text: state.text ?? saved,
    setText: (text: string) => store.type(text, saved),
    commit: (content: string, save: () => Promise<boolean>, rebase?: (text: string) => string) =>
      store.commit(content, save, "committed", rebase),
    discard: (save: () => Promise<boolean> = async () => true) => store.commit(state.text ?? saved, save, "discarded"),
    undo: store.undo,
    showHistory: store.history,
    restore: store.restore,
    acknowledge: store.acknowledge,
    loadRemote: async () => {
      if (await store.resolveRemote(true)) window.location.reload()
    },
    keepLocal: () => store.resolveRemote(false)
  }
}

type UserDraft = ReturnType<typeof useUserDraft>

/**
 * A form's undo: one small button for its header, opening the field's server-kept history. The
 * history is read when it opens; picking a version restores it. `place` sizes it like its
 * neighbours: a composer's buttons, or the small ones in a text box's strip.
 */
export function UserDraftUndo({ draft, place }: { draft: UserDraft; place?: "composer" | "strip" }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) draft.showHistory()
      }}
      trigger={<Icon name="undo" />}
      triggerLabel="Undo / history"
      hint="Undo / history"
      triggerClassName={`${iconButtonClass()} ${place === "composer" ? "size-9!" : place === "strip" ? chromeButton : ""}`}
      title="Undo / history"
      side="bottom"
      align="end"
    >
      <Button
        hint="Reverts the latest field change."
        disabled={!draft.ready}
        onClick={() => {
          draft.undo()
          draft.showHistory()
        }}
      >
        Undo field change
      </Button>
      {draft.history === null ? (
        draft.error ? (
          <p role="alert" className="text-sm text-danger">
            {draft.error}
          </p>
        ) : (
          <p className="text-sm text-muted">Reading the history…</p>
        )
      ) : draft.history.length === 0 ? (
        <p className="text-sm text-muted">No earlier versions yet.</p>
      ) : (
        <ul aria-label="Field undo history" className="-mx-1 flex min-h-0 flex-col overflow-auto">
          {draft.history.map((entry) => (
            <li key={entry.seq}>
              <Tooltip label="Loads this earlier field text.">
                <button
                  type="button"
                  className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
                  onClick={() => {
                    draft.restore(entry.seq)
                    setOpen(false)
                  }}
                >
                  <span>
                    {entry.kind === "initial" ? "Starting text" : new Date(entry.at).toLocaleString()}{" "}
                    <span className="text-muted">· {entry.length} characters</span>
                  </span>
                  {entry.inserted && <span className="line-clamp-1 text-xs text-muted">{entry.inserted}</span>}
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  )
}

/** What a draft needs to tell the user: a failed save, recovered text, another device's edit. */
export function UserDraftNotices({ draft }: { draft: UserDraft }) {
  if (!draft.error && draft.recovered === 0 && !draft.remote && !draft.displaced) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
      {draft.error && (
        <span role="alert" className="text-danger">
          {draft.error}
        </span>
      )}
      {draft.recovered > 0 && (
        <span>
          Earlier text from this draft is kept in{" "}
          <a className="underline" href="/bin?section=recovered">
            the bin, under Recovered text
          </a>
          .
        </span>
      )}
      {draft.remote && (
        <div role="status" className="flex w-full flex-col gap-2 text-text">
          {draft.remote.status === "active" ? (
            <>
              <span>Another device saved a different draft. Your unsaved text is still here.</span>
              <details>
                <Tooltip label="Previews the other saved edit.">
                  <summary>Preview the other device's text</summary>
                </Tooltip>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{draft.remote.content}</pre>
              </details>
            </>
          ) : (
            <span>
              Another device finished this draft. Reload to read the saved value. Your text will be kept in the bin,
              under Recovered text.
            </span>
          )}
          <div className="flex flex-wrap gap-2">
            <Button hint="Loads the latest text saved on the server." variant="ghost" onClick={draft.loadRemote}>
              {draft.remote.status === "active" ? "Load the other device's text" : "Reload saved value"}
            </Button>
            <Button hint="Keeps the text currently in this field." variant="ghost" onClick={draft.keepLocal}>
              Keep my text
            </Button>
          </div>
        </div>
      )}
      {draft.displaced && (
        <div role="status" className="flex w-full flex-col gap-2">
          <span>Another edit from {new Date(draft.displaced.at).toLocaleString()} is kept in field undo history.</span>
          <details>
            <Tooltip label="Previews the other saved edit.">
              <summary>Preview the other edit</summary>
            </Tooltip>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{draft.displaced.content}</pre>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button
              hint="Loads the other edit into this field."
              variant="ghost"
              onClick={() => {
                draft.setText(draft.displaced!.content)
                draft.acknowledge()
              }}
            >
              Use the other edit
            </Button>
            <Button hint="Keeps the edit currently in this field." variant="ghost" onClick={draft.acknowledge}>
              Keep this edit
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Draft notices, with history explicitly enabled by editors that need it. */
export function UserDraftStatus({ draft, history = false }: { draft: UserDraft; history?: boolean }) {
  if (!history) return <UserDraftNotices draft={draft} />
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <UserDraftUndo draft={draft} />
      </div>
      <UserDraftNotices draft={draft} />
    </div>
  )
}
