// An export asked for anywhere (a card's editor, the character or persona tab, the library's
// item menu), answered by the one host the feature registers in `appTools`: it checks for
// unsaved changes first and asks about them in a dialog, so the asking survives the menu that
// asked closing (owner, 2026-11-02: "If someone is exporting after edits it's likely they
// forgot to save and they can't even check after export"). Kept apart from the dialog, so a
// trigger doesn't load the editor's store.
import type { RefId } from "@dreamspan/shared/library.ts"
import type { ExportFormat } from "@dreamspan/shared/libraryImport.ts"
import { useSyncExternalStore } from "react"

export interface ExportRequest {
  readonly id: number
  readonly refId: RefId
  readonly format: ExportFormat
  /** The format's name, for the dialog: "PNG". */
  readonly formatLabel: string
  /** What's exported, for the file name and the dialog: the card's name. */
  readonly label: string
}

let current: ExportRequest | null = null
let next = 1
const listeners = new Set<() => void>()
const notify = () => {
  for (const listener of listeners) listener()
}

/** Exports `refId` in `format`, asking first if it has unsaved changes. */
export const requestExport = (request: Omit<ExportRequest, "id">) => {
  current = { ...request, id: next++ }
  notify()
}

export const endExport = (id: number) => {
  if (current?.id !== id) return
  current = null
  notify()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useExportRequest = () => useSyncExternalStore(subscribe, () => current)
