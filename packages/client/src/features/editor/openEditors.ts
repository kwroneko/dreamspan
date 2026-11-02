// The editors open on this page (each `useLeaveGuard`), for what happens around a reply (owner,
// 2026-11-01: live text is what's sent): before a reply is asked for, what's typed and not on
// the server yet goes there; after a reply cut revisions of what it used, each reads its state
// again. Kept apart from store.ts so the chat can register this without loading the editors.
// Export asks about unsaved changes with the editor that has them, when one is open (owner,
// 2026-11-02), so it finds them here by ref.

interface OpenEditor {
  readonly flush: () => Promise<unknown>
  readonly refresh: () => Promise<unknown>
  /** The ref it edits and the editor's store, for a feature that acts on the same changes. */
  readonly refId?: string
  readonly store?: unknown
}

const open = new Map<OpenEditor, number>()
const listeners = new Set<() => void>()
const changed = () => {
  for (const listener of listeners) listener()
}

/** Told when an editor opens or closes; the returned function stops it. */
export const subscribeOpenEditors = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Counts one more place guarding `editor`; the returned function undoes it. Listeners hear of
 * it after the effect that called this: told within it, a listener's re-render ran inside
 * another component's commit and lost a message editor's focus (snippets.spec).
 */
export const trackOpenEditor = (editor: OpenEditor) => {
  open.set(editor, (open.get(editor) ?? 0) + 1)
  queueMicrotask(changed)
  return () => {
    const count = (open.get(editor) ?? 1) - 1
    if (count > 0) open.set(editor, count)
    else open.delete(editor)
    queueMicrotask(changed)
  }
}

export const flushOpenEditors = () => Promise.all([...open.keys()].map((editor) => editor.flush()))

/** The store of an editor open on `refId`, if one is. */
export const openEditorStore = (refId: string): unknown =>
  [...open.keys()].find((editor) => editor.refId === refId && editor.store !== undefined)?.store

/**
 * How many times a chat's state changed while editors were open: an editor kept while its tab
 * was closed (a workspace's store) reads its state again when it's shown, if it missed one.
 */
let changes = 0
export const stateChanges = () => changes

export const refreshOpenEditors = () => {
  changes++
  return Promise.all([...open.keys()].map((editor) => editor.refresh()))
}
