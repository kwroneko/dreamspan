// The editors open on this page (each `useLeaveGuard`), for what happens around a reply (owner,
// 2026-11-01: live text is what's sent): before a reply is asked for, what's typed and not on
// the server yet goes there; after a reply cut revisions of what it used, each reads its state
// again. Kept apart from store.ts so the chat can register this without loading the editors.

interface OpenEditor {
  readonly flush: () => Promise<unknown>
  readonly refresh: () => Promise<unknown>
}

const open = new Map<OpenEditor, number>()

/** Counts one more place guarding `editor`; the returned function undoes it. */
export const trackOpenEditor = (editor: OpenEditor) => {
  open.set(editor, (open.get(editor) ?? 0) + 1)
  return () => {
    const count = (open.get(editor) ?? 1) - 1
    if (count > 0) open.set(editor, count)
    else open.delete(editor)
  }
}

export const flushOpenEditors = () => Promise.all([...open.keys()].map((editor) => editor.flush()))

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
