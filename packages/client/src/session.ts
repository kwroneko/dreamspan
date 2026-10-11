// Who the user is and how they're signed in (GetSession), plus login and logout, which
// are plain HTTP because only a response can set the session cookie (ARCHITECTURE §4).
import type { Session } from "@rp/shared/api.ts"
import { createContext, useContext } from "react"
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

/**
 * Ends the session and reloads into the login page. A full load, not a client-side
 * navigation, so the WebSocket and everything cached for this user go with it.
 */
export const logout = async () => {
  await fetch("/auth/logout", { method: "POST" }).catch(() => undefined)
  location.replace("/login")
}

/** Where to go after login: a path on this site only, so a link can't send the user elsewhere. */
export const safeNext = (next: unknown) =>
  typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/"
