// Who the user is and how they're signed in (GetSession), plus login and logout, which
// are plain HTTP because only a response can set the session cookie (ARCHITECTURE §4).
import type { Session } from "@rp/shared/api.ts"
import { createContext, useContext } from "react"
import { browserOnly, flushCopies } from "./features/editor/backup.ts"
import { AppClient } from "./rpc.ts"

export const sessionAtom = AppClient.query("GetSession", undefined)

/** The signed-in session, for everything inside the app shell. */
export const SessionContext = createContext<Session | null>(null)

export const useSession = (): Session => {
  const session = useContext(SessionContext)
  if (session === null) throw new Error("useSession outside the app shell")
  return session
}

export type LoginOutcome =
  | { readonly _tag: "LoggedIn" }
  | { readonly _tag: "WrongPassword" }
  | { readonly _tag: "Throttled"; readonly retryAfterS: number }
  | { readonly _tag: "ProxyMode" }
  | { readonly _tag: "Failed"; readonly message: string }

export const login = async (handle: string, password: string): Promise<LoginOutcome> => {
  let response: Response
  try {
    response = await fetch("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, password })
    })
  } catch {
    return { _tag: "Failed", message: "Can't reach the server. Check that it's running." }
  }
  switch (response.status) {
    case 204:
      return { _tag: "LoggedIn" }
    case 401:
      return { _tag: "WrongPassword" }
    case 404:
      return { _tag: "ProxyMode" }
    case 429:
      return { _tag: "Throttled", retryAfterS: Math.max(1, Number(response.headers.get("retry-after")) || 60) }
    default:
      return { _tag: "Failed", message: `The server couldn't log you in (${response.status}).` }
  }
}

/** Ends the session after flushing copies; the caller carries recovery information into login. */
export const logout = async (userId: string): Promise<{ readonly error: string; readonly recovered: number }> => {
  const { copies, recovered } = await flushCopies(userId)
  const failed = (error: string) => ({ error, recovered })
  // A copy that stays in this browser anyway (`browserOnly`) waits for this user's next login.
  if (copies.some((copy) => !browserOnly(copy)))
    return failed("Some text could not be saved. Recover it or explicitly delete its browser copy before logging out.")
  let response: Response
  try {
    response = await fetch("/auth/logout", { method: "POST" })
  } catch {
    return failed("Can't reach the server, so you're still logged in.")
  }
  if (!response.ok) return failed(`The server couldn't log you out (${response.status}), so you're still logged in.`)
  return { error: "", recovered }
}

/**
 * Where to go after login: a page on this site only, so a link can't send the user
 * elsewhere. Resolved the way the browser will (it drops tabs and newlines, and reads
 * a backslash as a slash), then checked by origin.
 */
export const safeNext = (next: unknown) => {
  if (typeof next !== "string") return "/"
  try {
    const url = new URL(next, location.origin)
    return url.origin === location.origin ? `${url.pathname}${url.search}${url.hash}` : "/"
  } catch {
    return "/"
  }
}
