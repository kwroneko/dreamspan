import { TextActionHost } from "../textActions.tsx"
import { defineSlot, SlotOutlet } from "../slots.tsx"
export const appTools = defineSlot<Record<string, never>>("app.tools")
/**
 * Lines across the top of every screen, above the page and below the phone bar: what the
 * user should see wherever they are (a running import, say). Empty, it takes no room.
 */
export const appBanners = defineSlot<Record<string, never>>("app.banners")
/** Actions in the sidebar's header row; `onNavigate` closes the phone sheet. */
export const sidebarActions = defineSlot<{ onNavigate: (() => void) | undefined }>("shell.sidebar.actions")
// The app shell: it lets nobody past without a session (the server decides; this only
// routes to login), then renders the sidebar (the chats, then the rest) and the screen.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useState } from "react"
import { ErrorAlert } from "../actions.tsx"
import { BrowserRecovery, RecoveryNotice } from "./editor/BrowserRecovery.tsx"
import { describeCause } from "../errors.ts"
import { fullPath, navEntries, routes } from "../routes.tsx"
import { logout, SessionContext, sessionAtom, useSession } from "../session.ts"
import { Button } from "../ui/Button.tsx"
import { ImageControls } from "../ui/ImageControls.tsx"
import { ResizeHandle, usePanelWidth } from "../ui/ResizeHandle.tsx"
import { Loading } from "../ui/Spinner.tsx"
import { Toasts } from "../ui/Toast.tsx"
import { ShellBrowser } from "./characters/ShellBrowser.tsx"
import { ShellNavigation, useShellNavigation } from "./characters/shellData.tsx"
import { sidebarSearch } from "./characters/sidebarSearch.ts"
import { setPageTitle, useNotices } from "./notices.tsx"

/** Sets the tab's title while a screen is shown. */
export const useTitle = (title: string) => {
  useEffect(() => {
    setPageTitle(`${title} · rp-harness`)
  }, [title])
}

export function CenteredPage({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-4 px-4 py-10">{children}</main>
  )
}

/** Hears about replies finishing elsewhere while a session is open (notices.tsx). */
function Notices() {
  useNotices()
  return null
}

/** Logs out, or says why it couldn't. */
export function LogoutButton({ variant = "secondary" }: { variant?: "secondary" | "ghost" }) {
  const userId = useSession().user.id
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [recovered, setRecovered] = useState(0)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant={variant}
        pending={pending}
        onClick={async () => {
          setPending(true)
          setError("")
          const result = await logout(userId)
          const count = recovered + result.recovered
          setRecovered(count)
          setError(result.error)
          if (!result.error) location.replace(count > 0 ? "/login?recovered=1" : "/login")
          setPending(false)
        }}
      >
        Log out
      </Button>
      {recovered > 0 && <RecoveryNotice />}
      {error.startsWith("Some text could not be saved.") && (
        <BrowserRecovery userId={userId} initiallyOpen initiallyRecovered={recovered} />
      )}
      {error && (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      )}
    </div>
  )
}

const navLink =
  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted hover:bg-surface-raised hover:text-text data-[status=active]:bg-surface-raised data-[status=active]:text-text"

/** Everything but the chats: the library, import, settings, the bin, the account. */
function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const session = useSession()
  const isAdmin = session.user.role === "admin"
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      <Link to="/" activeOptions={{ exact: true }} className={navLink} onClick={onNavigate}>
        Characters
      </Link>
      {navEntries("app", isAdmin)
        .filter((entry) => fullPath(entry) !== "/" && fullPath(entry) !== "/chats")
        .map((entry) => (
          <Link key={entry.id} to={fullPath(entry)} className={navLink} onClick={onNavigate}>
            {entry.nav!.label}
          </Link>
        ))}
      <Link to="/bin" className={navLink} onClick={onNavigate}>
        Bin
      </Link>
      <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-border px-2.5 pt-2 text-sm">
        <Link
          to="/settings/account"
          title={`Signed in as ${session.user.displayName} (${session.user.role})`}
          className="max-w-40 truncate text-muted hover:text-text"
          onClick={onNavigate}
        >
          {/* Without accounts the one user is "local", which says nothing. */}
          {session.via === "local" ? "Account" : session.user.displayName}
        </Link>
        <BrowserRecovery userId={session.user.id} />
        {session.via === "session" && <LogoutButton variant="ghost" />}
      </div>
    </nav>
  )
}

/** The sidebar: the chats first, as in any chat app, then the rest. */
function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  // On the chats page the list is the page; the sidebar doesn't show it twice.
  const onChats = useLocation({ select: (location) => location.pathname === "/chats" })
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="flex items-center gap-1 px-1">
        <Link to="/" className="mr-auto truncate font-semibold" onClick={onNavigate}>
          rp-harness
        </Link>
        <SlotOutlet slot={sidebarActions} props={{ onNavigate }} />
        <ImageControls />
      </div>
      {onChats ? <div className="flex-1" /> : <ShellBrowser />}
      <Navigation {...(onNavigate ? { onNavigate } : {})} />
    </div>
  )
}

// The phone's menu opened from elsewhere: an open chat's header takes the bar's place there.
const menuRequests = new Set<() => void>()
export const openAppMenu = () => {
  for (const request of menuRequests) request()
}

/** Phones: a bar with the menu, which opens the sidebar over the page. */
function PhoneBar() {
  // Open on the page it was opened on: going anywhere closes it. Browsing the panel itself
  // (its crumbs and tabs, in the URL's sidebar params) doesn't; picking in it does.
  const href = useLocation({
    select: (location) => {
      const params = new URLSearchParams(location.searchStr)
      for (const key of sidebarSearch) params.delete(key)
      return `${location.pathname}?${params}`
    }
  })
  const { selection } = useShellNavigation()
  // On a phone, an open chat's header takes this bar's place; its ← opens this menu (ChatHeader.tsx).
  const inChat = useLocation({ select: (location) => /^\/chats\/[^/]+$/.test(location.pathname) })
  const pathname = `${href}/${selection}`
  const [openOn, setOpenOn] = useState<string | null>(null)
  const open = openOn === pathname
  const setOpen = (next: boolean) => setOpenOn(next ? pathname : null)
  useEffect(() => {
    const request = () => setOpenOn(pathname)
    menuRequests.add(request)
    return () => void menuRequests.delete(request)
  }, [pathname])
  return (
    <>
      <div
        className={`flex items-center gap-2 border-b border-border bg-surface px-3 py-2 lg:hidden ${inChat ? "max-sm:hidden" : ""}`}
      >
        <button
          type="button"
          aria-label="Chats and menu"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="rounded-md px-2 py-1 text-lg leading-none hover:bg-surface-raised"
        >
          ☰
        </button>
        <Link to="/" className="font-semibold max-sm:hidden">
          rp-harness
        </Link>
        <div className="ml-auto max-sm:order-2">
          <ImageControls />
        </div>
        <nav aria-label="Screens" className="flex gap-1 max-sm:order-1">
          <Link to="/" activeOptions={{ exact: true }} className={navLink}>
            Characters
          </Link>
          <Link to="/chats" activeOptions={{ exact: true }} className={navLink}>
            Chats
          </Link>
        </nav>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="flex w-[min(22rem,88vw)] flex-col border-r border-border bg-surface shadow-xl">
            <Sidebar onNavigate={() => setOpen(false)} />
          </div>
          <button
            type="button"
            aria-label="Close the menu"
            className="flex-1 bg-overlay"
            onClick={() => setOpen(false)}
          />
        </div>
      )}
    </>
  )
}

function DesktopSidebar() {
  const userId = useSession().user.id
  const { ref, width, min, max, change, reset } = usePanelWidth(userId, "sidebar", 320, 220, 420, 700)
  return (
    <aside
      ref={ref}
      style={{ width, minWidth: 220, maxWidth: "calc(100% - 700px)" }}
      className="relative hidden shrink-0 border-r border-border bg-surface lg:block"
    >
      <Sidebar />
      <ResizeHandle
        label="Resize sidebar"
        width={width}
        min={min}
        max={max}
        direction={1}
        onChange={change}
        onReset={reset}
      />
    </aside>
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
        <Loading label="Connecting to the server…" onRetry={retry} />
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
      <ShellNavigation key={result.value.user.id}>
        <Notices />
        <a
          href="#content"
          className="sr-only rounded-md bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:ring-2 focus:ring-focus"
        >
          Skip to content
        </a>
        <Toasts>
          <SlotOutlet slot={appTools} props={{}} />
          <div className="flex h-dvh">
            <DesktopSidebar key={result.value.user.id} />
            <div className="flex min-w-0 flex-1 flex-col">
              <PhoneBar />
              <SlotOutlet slot={appBanners} props={{}} />
              <Main />
            </div>
          </div>
        </Toasts>
      </ShellNavigation>
    </SessionContext>
  )
}

/**
 * Chats, and chats not made yet (a card's or a group's first greetings), fill the height and
 * scroll their own messages, the composer always in view; other screens scroll as pages.
 */
function Main() {
  const pathname = useLocation({ select: (location) => location.pathname })
  const fill = /^\/(?:chats\/[^/]+|cards\/[^/]+\/chat|groups\/[^/]+\/new)$/.test(pathname)
  return (
    <main id="content" className={`min-h-0 flex-1 ${fill ? "flex flex-col" : "overflow-y-auto"}`}>
      {fill ? (
        <Outlet />
      ) : (
        <div className="mx-auto w-full max-w-5xl px-4 py-6">
          <Outlet />
        </div>
      )}
    </main>
  )
}

export const register = () => {
  appTools.register({ id: "text-actions", order: 10, component: TextActionHost })
  routes.register({ id: "app", parent: "root", component: AppShell })
}
