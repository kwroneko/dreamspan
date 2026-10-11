// The app shell: it lets nobody past without a session (the server decides; this only
// routes to login), then renders the header and the registered screen.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Link, Navigate, Outlet, useLocation, useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useState } from "react"
import { ErrorAlert } from "../actions.tsx"
import { describeCause } from "../errors.ts"
import { fullPath, navEntries, routes } from "../routes.tsx"
import { logout, SessionContext, sessionAtom, useSession } from "../session.ts"
import { Button } from "../ui/Button.tsx"
import { Loading } from "../ui/Spinner.tsx"

/** Sets the tab's title while a screen is shown. */
export const useTitle = (title: string) => {
  useEffect(() => {
    document.title = `${title} · rp-harness`
  }, [title])
}

export function CenteredPage({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-4 px-4 py-10">{children}</main>
  )
}

/** Logs out, or says why it couldn't. */
export function LogoutButton({ variant = "secondary" }: { variant?: "secondary" | "ghost" }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        variant={variant}
        pending={pending}
        onClick={async () => {
          setPending(true)
          setError("")
          setError(await logout())
          setPending(false)
        }}
      >
        Log out
      </Button>
      {error && (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      )}
    </span>
  )
}

function Header() {
  const session = useSession()
  const isAdmin = session.user.role === "admin"
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
        <Link to="/" className="font-semibold">
          rp-harness
        </Link>
        <nav aria-label="Main" className="flex gap-1">
          {navEntries("app", isAdmin).map((entry) => (
            <Link
              key={entry.id}
              to={fullPath(entry)}
              activeOptions={{ exact: fullPath(entry) === "/" }}
              className="rounded-md px-2.5 py-1.5 text-sm text-muted hover:bg-surface-raised hover:text-text data-[status=active]:bg-surface-raised data-[status=active]:text-text"
            >
              {entry.nav!.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <Link to="/settings/account" className="max-w-40 truncate text-sm text-muted hover:text-text">
            {session.user.displayName}
          </Link>
          {session.via === "session" && <LogoutButton variant="ghost" />}
        </div>
      </div>
    </header>
  )
}

/**
 * Sends the user to login, to come back here afterwards. The page is the one shown when
 * the session ended: read once, since the location changes as the navigation starts.
 */
function ToLogin() {
  const navigate = useNavigate()
  const location = useLocation()
  const [next] = useState(location.href)
  useEffect(() => {
    void navigate({ to: "/login", search: { next }, replace: true })
  }, [navigate, next])
  return null
}

function AppShell() {
  const result = useAtomValue(sessionAtom)
  const retry = useAtomRefresh(sessionAtom)
  if (AsyncResult.isInitial(result)) {
    return (
      <CenteredPage>
        <Loading label="Connecting to the server…" />
      </CenteredPage>
    )
  }
  if (AsyncResult.isFailure(result)) {
    const error = describeCause(result.cause)
    if (error.tag === "Unauthorized") return <ToLogin />
    return (
      <CenteredPage>
        <ErrorAlert
          error={error}
          actions={
            <Button variant="ghost" onClick={retry}>
              Try again
            </Button>
          }
        />
      </CenteredPage>
    )
  }
  return (
    <SessionContext value={result.value}>
      <a
        href="#content"
        className="sr-only rounded-md bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:ring-2 focus:ring-focus"
      >
        Skip to content
      </a>
      <div className="flex min-h-full flex-col">
        <Header />
        <main id="content" className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
          <Outlet />
        </main>
      </div>
    </SessionContext>
  )
}

/** Settings: a section list from the registry beside (on phones, above) the open section. */
function SettingsLayout() {
  useTitle("Settings")
  const session = useSession()
  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <nav aria-label="Settings" className="-mx-4 overflow-x-auto px-4 md:mx-0 md:w-48 md:shrink-0 md:px-0">
        <ul className="flex gap-1 md:flex-col">
          {navEntries("settings", session.user.role === "admin").map((entry) => (
            <li key={entry.id}>
              <Link
                to={fullPath(entry)}
                className="block rounded-md px-3 py-2 text-sm whitespace-nowrap text-muted hover:bg-surface-raised hover:text-text data-[status=active]:bg-surface-raised data-[status=active]:font-medium data-[status=active]:text-text"
              >
                {entry.nav!.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  )
}

/** /settings opens its first section. */
function SettingsIndex() {
  const session = useSession()
  const [first] = navEntries("settings", session.user.role === "admin")
  return first ? <Navigate to={fullPath(first)} replace /> : null
}

export const register = () => {
  routes.register({ id: "app", parent: "root", component: AppShell })
  routes.register({
    id: "settings",
    parent: "app",
    path: "/settings",
    component: SettingsLayout,
    nav: { label: "Settings", order: 90 }
  })
  routes.register({ id: "settings.index", parent: "settings", path: "/", component: SettingsIndex })
}
