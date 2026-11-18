// Whether the Cast tab's Add characters section is open, a layout param in the browser tab's
// URL (`cadd=open`, `tabLayoutParams.ts`; closed while absent), and requests to open it from
// elsewhere: the speaker switcher's "Add to chat" opens the Cast tab and asks for it, so the
// person lands on the grid with its search focused rather than on a closed section. A request
// made before the tab has loaded is taken when the section mounts; without the section (a
// plugin removed it), a request does nothing.
import { writeLayoutParam } from "../../tabLayoutParams.ts"

const listeners = new Set<() => void>()
let requests = 0
let taken = 0
let requestedAt = 0
/** A request older than this is dropped: the tab it was for never opened. */
const FRESH_MS = 10_000

export const subscribeCastAdd = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Asks the Add characters section to open and focus its search. */
export const requestCastAdd = () => {
  requests++
  requestedAt = Date.now()
  for (const listener of listeners) listener()
}

/** Whether a request is waiting; true once per request, for the section that takes it. */
export const takeCastAddRequest = () => {
  if (taken === requests) return false
  taken = requests
  return Date.now() - requestedAt < FRESH_MS
}

/** The layout param (registered by the chat feature). */
export const CAST_ADD_PARAM = "cadd"

export const writeCastAddOpen = (open: boolean) => writeLayoutParam(CAST_ADD_PARAM, open ? "open" : null)
