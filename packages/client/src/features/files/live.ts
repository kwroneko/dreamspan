// Live refresh (spec/FILES-AND-ENVIRONMENT.md §8.1): the server's `FilesChanged` notices, after
// app-side changes and each command's scan, reach every open file manager of the account, which
// reads its folder again when the notice names it.
import type { Notice } from "@dreamspan/shared/noticeApi.ts"

type FilesChanged = Extract<Notice, { _tag: "FilesChanged" }>

const listeners = new Set<(changed: FilesChanged) => void>()

/** The notice receiver the files feature registers (`userNoticeReceivers`). */
export const filesNoticeReceiver = {
  id: "files.live",
  receive: (notice: Notice) => {
    if (notice._tag !== "FilesChanged") return
    for (const listener of listeners) listener(notice)
  }
}

/** Calls `onChange` when a notice says `folder`'s listing changed; returns the unsubscribe. */
export const onFolderChanged = (folder: string, onChange: () => void) => {
  const listener = (changed: FilesChanged) => {
    if (changed.all || changed.folders.includes(folder)) onChange()
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
