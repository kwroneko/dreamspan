// This browser's id for its saved workbench layout (@rp/shared/workbenchApi.ts WorkbenchDevice):
// a phone and a desktop on one account each restore their own frames and tabs.

import { uuid } from "../../uuid.ts"

const KEY = "rp.device"
/** For a browser that can't keep an id: such browsers share one layout, as before ids existed. */
const SHARED = "shared"
const VALID = /^[A-Za-z0-9_-]{1,64}$/

const read = (): string => {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored !== null && VALID.test(stored) && stored !== SHARED) return stored
    const id = uuid()
    localStorage.setItem(KEY, id)
    // A browser that drops what it's given would start over on every load.
    return localStorage.getItem(KEY) === id ? id : SHARED
  } catch {
    return SHARED
  }
}

let device: string | undefined

/** The id, made and kept on first use; one per page load, so a tab's saves stay together. */
export const deviceId = () => (device ??= read())
