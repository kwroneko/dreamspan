// Signing in with an MCP server (spec/MCP.md §2.4): the block on the server's Sign-in card and
// the page the server's sign-in sends the browser back to. The sign-in page opens in a new tab
// from the click itself (so no popup blocker), and the app keeps the user's own tokens; the
// callback tab tells the app's other tabs, which reload the server.
import type { McpConnection } from "@dreamspan/shared/mcp.ts"
import { Link } from "@tanstack/react-router"
import { useContext, useEffect, useRef, useState } from "react"
import { RegistryContext } from "@effect/atom-react"
import { ErrorAlert, invalidateKeys, useAction } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Alert, Card, CardHeader } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"
import { formatWhen } from "../chat/chatTitle.ts"
import { mcpHost } from "./data.ts"

/** The tabs of this app hear here when a sign-in finished, in any of them. */
const CHANNEL = "dreamspan-mcp-sign-in"

const channel = () => (typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL))

/** Reloads the servers when another tab finished a sign-in. */
function useSignInUpdates() {
  const registry = useContext(RegistryContext)
  useEffect(() => {
    const listening = channel()
    if (!listening) return
    listening.onmessage = () => invalidateKeys(registry, ["mcp"])
    return () => listening.close()
  }, [registry])
}

/** The "Sign in with the server" part of a remote server's Sign-in card. */
export function SignInWithServer({ connection }: { connection: McpConnection }) {
  const start = useAction()
  const out = useAction()
  const host = mcpHost(connection)
  const signIn = connection.use.signIn
  const origin = connection.url === null ? null : URL.canParse(connection.url) ? new URL(connection.url).origin : null
  const moved = signIn !== null && origin !== null && signIn.origin !== origin
  useSignInUpdates()
  const begin = async () => {
    // Opened now, from the click, then sent to the server's page once the app has it.
    const tab = window.open("", "_blank")
    const result = await start.run((client) =>
      client("StartMcpSignIn", { connectionId: connection.id, appOrigin: window.location.origin })
    )
    if (!tab) return
    if (!result.ok) {
      tab.close()
      return
    }
    // The sign-in page never gets a handle on this tab.
    tab.opener = null
    tab.location.href = result.value.authorizationUrl
  }
  return (
    <div className="flex flex-col gap-2" data-mcp-sign-in>
      <p className="text-sm font-medium">Sign in with the server</p>
      <p className="text-sm">
        {signIn === null ? (
          <span className="text-muted">Not signed in.</span>
        ) : (
          <>
            Signed in
            {signIn.expiresAt !== null && (
              <span className="text-muted"> · renews itself, next by {formatWhen(signIn.expiresAt)}</span>
            )}
          </>
        )}
      </p>
      {moved && (
        <Alert tone="warning" title="Sign in again">
          Your sign-in was for another address. Requests are refused until you sign in again.
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          hint={`Opens ${host}'s sign-in page in a new tab. The app keeps the sign-in, not your password.`}
          pending={start.pending}
          onClick={() => void begin()}
        >
          {signIn === null ? "Sign in" : "Sign in again"}
        </Button>
        <Button
          variant="ghost"
          disabled={signIn === null}
          focusableWhenDisabled
          pending={out.pending}
          hint={signIn === null ? "You aren't signed in." : `Forgets your sign-in with ${host}. Nothing is sent to it.`}
          onClick={() => void out.run((client) => client("SignOutOfMcp", { connectionId: connection.id }), ["mcp"])}
        >
          Sign out
        </Button>
      </div>
      <ErrorAlert error={start.error ?? out.error} title="Not signed in" />
    </div>
  )
}

type Finished =
  | { readonly state: "working" }
  | { readonly state: "done"; readonly connectionId: string; readonly name: string }
  | { readonly state: "failed"; readonly error: AppError | null }

/** Where the server's sign-in page sends the browser back (MCP_OAUTH_CALLBACK). */
export function McpSignInCallbackPage() {
  useTitle("Signing in")
  const action = useAction()
  const [query] = useState(() => new URLSearchParams(window.location.search))
  const [finished, setFinished] = useState<Finished>(() =>
    query.get("state") === null ? { state: "failed", error: null } : { state: "working" }
  )
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    // The code is used once; it doesn't stay in the tab's history.
    window.history.replaceState(window.history.state, "", window.location.pathname)
    const state = query.get("state")
    if (state === null) return
    void action
      .run(
        (client) =>
          client("FinishMcpSignIn", {
            state,
            code: query.get("code"),
            error: query.get("error_description") ?? query.get("error")
          }),
        ["mcp"]
      )
      .then((result) => {
        if (!result.ok) return setFinished({ state: "failed", error: result.error })
        setFinished({ state: "done", ...result.value })
        const telling = channel()
        telling?.postMessage("signed-in")
        telling?.close()
        // A tab the app opened closes itself; otherwise the page says it's done.
        window.close()
      })
  }, [action, query])
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-4" data-mcp-callback>
      <Card>
        <CardHeader
          title={finished.state === "done" ? `Signed in to ${finished.name}` : "Signing in with an MCP server"}
        />
        {finished.state === "working" && <p className="text-sm text-muted">Finishing the sign-in…</p>}
        {finished.state === "done" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm">You can close this tab. The app uses your sign-in when it calls the server.</p>
            <div className="flex flex-wrap gap-2">
              <Button hint="Closes this tab." onClick={() => window.close()}>
                Close this tab
              </Button>
              <Link
                to="/settings/mcp/$connectionId"
                params={{ connectionId: finished.connectionId }}
                className="self-center text-sm underline"
              >
                Open the server’s page
              </Link>
            </div>
          </div>
        )}
        {finished.state === "failed" && (
          <div className="flex flex-col gap-3">
            {finished.error ? (
              <ErrorAlert error={finished.error} title="Not signed in" />
            ) : (
              <Alert tone="danger" title="Not signed in">
                The server didn’t send the sign-in back. Start again from the server’s page.
              </Alert>
            )}
            <Link to="/settings/mcp" className="text-sm underline">
              MCP servers
            </Link>
          </div>
        )}
      </Card>
    </div>
  )
}
