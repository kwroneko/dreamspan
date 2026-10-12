// The login page (ARCHITECTURE §4). It shows the form only when the server says a
// session is required; otherwise it says why no login is needed.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { Session } from "@rp/shared/api.ts"
import { Link, useSearch } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, useEffect, useState } from "react"
import { ErrorAlert } from "../actions.tsx"
import { describeCause } from "../errors.ts"
import { routes } from "../routes.tsx"
import { login, type LoginOutcome, safeNext, sessionAtom } from "../session.ts"
import { Button, buttonClass } from "../ui/Button.tsx"
import { Field, formText, Input, PasswordInput } from "../ui/Field.tsx"
import { Loading } from "../ui/Spinner.tsx"
import { Alert, Card } from "../ui/Surface.tsx"
import { RecoveryNotice } from "./editor/BrowserRecovery.tsx"
import { CenteredPage, LogoutButton, useTitle } from "./shell.tsx"

const formatWait = (seconds: number) =>
  seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : `${seconds} s`

/** Counts down to zero, once a second. */
const useCountdown = (until: number | null) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [until])
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000))
}

function LoginForm({ next, passwordChanged }: { next: string; passwordChanged: boolean }) {
  const [handle, setHandle] = useState("")
  const [passwordEmpty, setPasswordEmpty] = useState(true)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<LoginOutcome | null>(null)
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null)
  const wait = useCountdown(blockedUntil)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    setPending(true)
    const result = await login(handle, formText(form, "password"))
    setOutcome(result)
    if (result._tag === "LoggedIn") {
      // A full load opens a new WebSocket, which carries the new session cookie.
      location.replace(next)
      return
    }
    setPending(false)
    if (result._tag === "Throttled") setBlockedUntil(Date.now() + result.retryAfterS * 1000)
    if (result._tag === "WrongPassword") {
      const field = form.elements.namedItem("password")
      if (field instanceof HTMLInputElement) field.value = ""
      setPasswordEmpty(true)
    }
  }

  if (outcome?._tag === "ProxyMode") {
    return (
      <Alert title="Login happens at your reverse proxy">
        This server takes its users from the proxy in front of it, so there's no login here. Reload the page through the
        proxy.
      </Alert>
    )
  }

  const throttled = outcome?._tag === "Throttled" && wait > 0
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {passwordChanged && outcome === null && (
        <Alert tone="success" title="Password changed">
          Log in with your new password.
        </Alert>
      )}
      {outcome?._tag === "WrongPassword" && (
        <Alert tone="danger" title="Wrong handle or password">
          Check both and try again. A disabled account can't log in; ask an admin if yours might be.
        </Alert>
      )}
      {throttled && (
        <>
          <Alert tone="danger" title="Too many attempts">
            The server asks you to wait before trying again.
          </Alert>
          {/* Outside the alert, so screen readers don't announce every second. */}
          <p className="text-sm text-muted">You can try again in {formatWait(wait)}.</p>
        </>
      )}
      {outcome?._tag === "Failed" && <Alert tone="danger">{outcome.message}</Alert>}
      <Field label="Handle">
        <Input
          name="handle"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={handle}
          onValueChange={setHandle}
        />
      </Field>
      <Field label="Password">
        <PasswordInput name="password" autoComplete="current-password" onEmptyChange={setPasswordEmpty} />
      </Field>
      <Button type="submit" variant="primary" pending={pending} disabled={throttled || handle === "" || passwordEmpty}>
        Log in
      </Button>
    </form>
  )
}

const signedInText = (session: Session) => {
  switch (session.via) {
    case "local":
      return "No account on this server has a password, so this browser is the local admin without logging in. Set a password in your account settings to require a login."
    case "loopback":
      return "This server lets its own machine in as the admin without logging in."
    case "proxy":
      return "Your reverse proxy signed you in."
    case "session":
      return null
  }
}

function SignedIn({ session, next }: { session: Session; next: string }) {
  const text = signedInText(session)
  return (
    <div className="flex flex-col gap-4">
      <Alert title={session.via === "session" ? "You're logged in" : "No login needed"}>
        <p>
          You're signed in as <strong>{session.user.displayName}</strong> ({session.user.handle}).
        </p>
        {text && <p className="mt-1 text-muted">{text}</p>}
      </Alert>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Link to={next} className={buttonClass("primary")}>
          Continue
        </Link>
        {session.via === "session" && <LogoutButton />}
      </div>
    </div>
  )
}

function LoginPage() {
  useTitle("Log in")
  const search: { next?: unknown; changed?: unknown; recovered?: unknown } = useSearch({ strict: false })
  const next = safeNext(search.next)
  const result = useAtomValue(sessionAtom)
  const retry = useAtomRefresh(sessionAtom)
  return (
    <CenteredPage>
      <h1 className="text-xl font-semibold">Log in to rp-harness</h1>
      {(search.recovered === "1" || search.recovered === 1) && <RecoveryNotice />}
      <Card>
        {AsyncResult.match(result, {
          onInitial: () => <Loading label="Connecting to the server…" />,
          onSuccess: ({ value }) => <SignedIn session={value} next={next} />,
          onFailure: ({ cause }) => {
            const error = describeCause(cause)
            return error.tag === "Unauthorized" ? (
              <LoginForm next={next} passwordChanged={search.changed !== undefined} />
            ) : (
              <ErrorAlert
                error={error}
                actions={
                  <Button variant="ghost" onClick={retry}>
                    Try again
                  </Button>
                }
              />
            )
          }
        })}
      </Card>
    </CenteredPage>
  )
}

export const register = () => {
  routes.register({ id: "login", parent: "root", path: "/login", component: LoginPage })
}
