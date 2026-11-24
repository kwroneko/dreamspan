import { Tooltip } from "../ui/Tooltip.tsx"
import { CenterHeaderHost, CenterHeaderFrame, centerHeaders } from "../ui/CenterHeader.tsx"
import { defineSlot, SlotOutlet } from "../slots.tsx"
export const navigationNotices = defineSlot<Record<string, never>>("shell.navigation.notices")
export const appTools = defineSlot<Record<string, never>>("app.tools")
/**
 * Lines across the top of every screen, above the page and below the phone bar: what the
 * user should see wherever they are (a running import, say). Empty, it takes no room.
 */
export const appBanners = defineSlot<Record<string, never>>("app.banners")
/**
 * The desktop sidebar's hide and show buttons: at the end of its header row while it shows
 * (`sidebar`), at the start of the page's header while it's hidden (`header`: the chat's,
 * or the bar above any other page), or in tab mode at the start of the top-left frame's tab
 * strip instead (`strip`, features/workbench).
 */
export const sidebarToggle = defineSlot<{ place: "sidebar" | "header" | "strip" }>("shell.sidebar.toggle")
/**
 * What fills the center column: the first entry registered (the workbench's frames and tabs,
 * features/workbench), else the routed page itself.
 */
export const centerColumn = defineSlot<Record<string, never>>("shell.center")
// The app shell: it lets nobody past without a session (the server decides; this only
// routes to login), then renders the sidebar (the chats, then the rest) and the screen.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Link, Outlet, useLocation, useMatches, useNavigate, useSearch } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { DIALOG_COLUMN } from "../ui/Dialog.tsx"
import { ErrorAlert } from "../actions.tsx"
import { BrowserRecovery, RecoveryNotice } from "./editor/BrowserRecovery.tsx"
import { appDurableFields } from "./editor/durable.tsx"
import { DurableFieldsContext } from "../ui/durableFields.tsx"
import { describeCause } from "../errors.ts"
import { fullPath, navEntries, routes } from "../routes.tsx"
import { logout, SessionContext, sessionAtom, useSession } from "../session.ts"
import { Button } from "../ui/Button.tsx"
import { WindowClose } from "../ui/WindowClose.tsx"
import { ImageControls } from "../ui/ImageControls.tsx"
import { ResizeHandle, usePanelWidth, WIDTH_PARAMS } from "../ui/ResizeHandle.tsx"
import { NavigationTiles } from "../ui/NavigationTiles.tsx"
import { Loading } from "../ui/Spinner.tsx"
import { Toasts } from "../ui/Toast.tsx"
import { IconButton } from "../ui/Tooltip.tsx"
import { ShellBrowser } from "./characters/ShellBrowser.tsx"
import { ShellNavigation, useShellNavigation } from "./characters/shellData.tsx"
import { sidebarSearch } from "./characters/sidebarSearch.ts"
import { setPageTitle, useNotices } from "./notices.tsx"
import { LinkMenu } from "../ui/LinkMenu.tsx"
import { useTabFocused, useTabInStrips, useTabMeta } from "./workbench/tab.tsx"
import { layoutKeys, layoutParams, useLayoutParam, viewKeys, writeLayoutParam } from "../tabLayoutParams.ts"

/**
 * Sets the browser tab's title while a screen is shown, and names its workbench tab; only the
 * focused one names the browser's.
 */
export const useTitle = (title: string) => {
  const focused = useTabFocused()
  useTabMeta(title)
  useEffect(() => {
    if (focused) setPageTitle(`${title} · Dreamspan`)
  }, [title, focused])
}

export function CenteredPage({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-4 px-4 py-10">
      <SlotOutlet slot={appBanners} props={{}} only="plugins.host" />
      {children}
    </main>
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
        hint="Saves any text still being written, then ends this session."
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

/** Everything but the chats: the library, import, settings, the bin, the account. */
function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const session = useSession()
  const isAdmin = session.user.role === "admin"
  return (
    <nav aria-label="Main" className="flex shrink-0 flex-col gap-0.5">
      <SlotOutlet slot={navigationNotices} props={{}} />
      <NavigationTiles
        onNavigate={onNavigate}
        items={[
          { to: "/", label: "Home", icon: "home", description: "Open the home page." },
          ...navEntries("app", isAdmin)
            .filter((entry) => fullPath(entry) !== "/" && fullPath(entry) !== "/chats")
            .map((entry) => ({
              to: fullPath(entry),
              label: entry.nav!.label,
              icon: entry.nav!.icon ?? "panel",
              description: entry.nav!.description ?? `Open ${entry.nav!.label}.`
            })),
          { to: "/bin", label: "Bin", icon: "trash", description: "Browse deleted items." }
        ]}
      />
    </nav>
  )
}

/** The sidebar: the chats first, as in any chat app, then the rest. */
function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  // On the chats page the list is the page; the sidebar doesn't show it twice.
  const onChats = useLocation({ select: (location) => location.pathname === "/chats" })
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-3 pb-3">
      <div className="-mx-3 mb-1 flex h-shell-header shrink-0 items-center gap-1 border-b border-border px-5 py-2">
        <Tooltip label="Opens the home page.">
          <Link to="/" className="mr-auto truncate font-semibold" onClick={onNavigate}>
            Dreamspan
          </Link>
        </Tooltip>
        <ImageControls />
        {!onNavigate && <SlotOutlet slot={sidebarToggle} props={{ place: "sidebar" }} />}
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

// Wide enough for the desktop sidebar (Tailwind's `lg`). Below it the sidebar is the phone's
// menu, so only one of the two is ever mounted: a hidden desktop one ran its own queries (a card
// source's search went out twice on a phone). Read during render, so the first frame is right.
const DESKTOP = "(min-width: 64rem)"
const subscribeDesktop = (listener: () => void) => {
  const query = matchMedia(DESKTOP)
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}
const useDesktop = () => useSyncExternalStore(subscribeDesktop, () => matchMedia(DESKTOP).matches)

/** Phones: a bar with the menu, which opens the sidebar over the page. */
function PhoneBar() {
  const desktop = useDesktop()
  // Open on the page it was opened on: going anywhere closes it. Browsing the panel itself
  // (its crumbs and tabs, in the URL's sidebar params) doesn't, nor does changing the layout
  // (a foot section closed, a height dragged: layout params), nor a page's own view params (an
  // opening chat writing its Messages or Summaries choice); picking in it does.
  const href = useLocation({
    select: (location) => {
      const params = new URLSearchParams(location.searchStr)
      for (const key of [...sidebarSearch, ...layoutKeys(), ...viewKeys()]) params.delete(key)
      // The same place whatever order its keys come in: writing a sidebar key can reorder the rest.
      params.sort()
      return `${location.pathname}?${params}`
    }
  })
  const { selection } = useShellNavigation()
  const pathname = `${href}/${selection}`
  const [openOn, setOpenOn] = useState<string | null>(null)
  // The menu is for narrow windows: widened with it open, the desktop sidebar takes its place.
  const open = openOn === pathname && !desktop
  const setOpen = (next: boolean) => setOpenOn(next ? pathname : null)
  useEffect(() => {
    const request = () => setOpenOn(pathname)
    menuRequests.add(request)
    return () => void menuRequests.delete(request)
  }, [pathname])
  return (
    <>
      {open && (
        <div
          data-layout-overlay="Mobile navigation drawer covers the page"
          className="fixed inset-0 z-40 flex lg:hidden"
        >
          <div className="flex w-[min(22rem,88vw)] flex-col border-r border-border bg-surface shadow-xl">
            <div className="flex justify-end p-3">
              <WindowClose onClick={() => setOpen(false)} />
            </div>
            <Sidebar onNavigate={() => setOpen(false)} />
          </div>
          <Tooltip label="Closes the navigation menu.">
            <button
              type="button"
              aria-label="Close the menu"
              className="flex-1 bg-overlay"
              onClick={() => setOpen(false)}
            />
          </Tooltip>
        </div>
      )}
    </>
  )
}

// --- Whether the desktop sidebar is hidden: the browser tab's URL says so (`sidebar=hidden`,
// a layout param: `tabLayoutParams.ts`), so a reload, Back, Forward or a copied link shows it
// the same, navigation keeps it and no other tab follows it (owner, 2026-11-18). Absent, it's
// shown. Phones and tablets don't use it: their sidebar is the menu over the page.

const SIDEBAR = "sidebar"
const setSidebarHidden = (next: boolean) => writeLayoutParam(SIDEBAR, next ? "hidden" : null)
/** Reveal navigation after an entry point elsewhere scopes the left column. */
export const showAppNavigation = () => {
  setSidebarHidden(false)
  if (!matchMedia(DESKTOP).matches) openAppMenu()
}
/** The button to focus once the sidebar has hidden or shown, so focus isn't lost with it. */
let focusNext: "sidebar" | "header" | null = null

function useSidebarHidden(): [boolean, (hidden: boolean) => void] {
  return [useLayoutParam(SIDEBAR) === "hidden", setSidebarHidden]
}

/**
 * Hides the sidebar from its header row, or shows it again from the page's header, or in tab
 * mode from the top-left tab strip (owner, 2026-11-07: the headers then have none).
 */
function SidebarToggle({ place }: { place: "sidebar" | "header" | "strip" }) {
  const [hidden, setHidden] = useSidebarHidden()
  const ref = useRef<HTMLButtonElement>(null)
  const strips = useTabInStrips()
  const shown = place === "sidebar" ? !hidden : hidden && (place === "strip" || !strips)
  // Hiding the sidebar focuses the show button that comes: the header's or the strip's.
  const focusPlace = place === "sidebar" ? "sidebar" : "header"
  useEffect(() => {
    // The one on screen: a page can hold another out of view (the tablet bar's, in a chat).
    if (shown && focusNext === focusPlace && ref.current?.checkVisibility()) {
      focusNext = null
      ref.current?.focus()
    }
  }, [shown, focusPlace])
  if (!shown) return null
  return place === "sidebar" ? (
    <IconButton
      ref={ref}
      label="Hide the sidebar"
      hint="Click to hide the sidebar"
      icon="sidebar"
      onClick={() => {
        focusNext = "header"
        setHidden(true)
      }}
    />
  ) : (
    <IconButton
      ref={ref}
      label="Show the sidebar"
      hint="Click to show the sidebar: your chats, characters and the menu"
      icon="sidebar"
      // A phone's and a tablet's sidebar is the menu over the page; this is the desktop's.
      className={place === "strip" ? "size-7 max-lg:hidden" : "max-lg:hidden"}
      onClick={() => {
        focusNext = "sidebar"
        setHidden(false)
      }}
    />
  )
}

/** The desktop sidebar on a desktop-wide window, unless the user hid it. */
function DesktopSidebarColumn() {
  const [hidden] = useSidebarHidden()
  const desktop = useDesktop()
  return hidden || !desktop ? null : <DesktopSidebar />
}

function DesktopSidebar() {
  const { width, min, max, change, reset } = usePanelWidth("sidebar", 320, 220)
  // Its live width for what covers it exactly: a side sheet it opens (ui/Sheet.tsx).
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`)
  }, [width])
  useLayoutEffect(
    () => () => {
      document.documentElement.style.removeProperty("--sidebar-width")
    },
    []
  )
  return (
    <aside
      aria-label="Sidebar"
      {...{ [DIALOG_COLUMN]: "" }}
      style={{ width }}
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
            <Button hint="Retries loading this view." variant="ghost" onClick={retry}>
              Try again
            </Button>
          }
        />
      </CenteredPage>
    )
  }
  return (
    <SessionContext value={result.value}>
      <DurableFieldsContext value={appDurableFields}>
        <ShellNavigation key={result.value.user.id}>
          <Notices />
          {/* Every app link's right-click menu: Open, Open beside, Open in a new browser tab. */}
          <LinkMenu />
          <a
            href="#content"
            className="sr-only rounded-md bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:ring-2 focus:ring-focus"
          >
            Skip to content
          </a>
          <Toasts>
            <SlotOutlet slot={appTools} props={{}} />
            <div className="flex h-dvh">
              <DesktopSidebarColumn key={result.value.user.id} />
              <div className="flex min-w-0 flex-1 flex-col">
                <PhoneBar />
                <SlotOutlet slot={appBanners} props={{}} />
                <Main />
              </div>
            </div>
          </Toasts>
        </ShellNavigation>
      </DurableFieldsContext>
    </SessionContext>
  )
}

/**
 * Chats, and chats not made yet (a card's or a group's first greetings), fill the height and
 * scroll their own messages, the composer always in view; other screens scroll as pages.
 * A workbench tab shows its page through this too.
 */
export function CenterPage() {
  const pathname = useLocation({ select: (location) => location.pathname })
  // The screen shown says so itself (RouteEntry.fill). A path list here missed the chat with a
  // card source's card (composerbottom1): its composer sat under the greeting, mid-screen.
  const fill = useMatches({ select: (matches) => matches.at(-1)?.staticData.fill === true })
  const fillBelowHeader = useMatches({ select: (matches) => matches.at(-1)?.staticData.fillBelowHeader === true })
  // An editor opened from a chat scrolls itself, as the chat's large editors did (BoundScroll).
  const bound = useSearch({ strict: false, select: (search) => typeof search.chat === "string" && search.chat !== "" })
  if (fill) return <Outlet />
  const own = (bound && pathname.startsWith("/library/")) || fillBelowHeader
  return (
    <CenterHeaderHost
      leading={
        <>
          <IconButton
            label="Chats and menu"
            hint="Opens the app menu."
            icon="back"
            className="lg:hidden"
            onClick={openAppMenu}
          />
          <SlotOutlet slot={sidebarToggle} props={{ place: "header" }} />
        </>
      }
    >
      {own ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </div>
      ) : (
        // The scrollbar's gutter is kept whether or not the page scrolls: a page growing past the
        // window or shrinking under it (a tab switch) never moves the centred column sideways.
        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          <div className="mx-auto w-full max-w-5xl px-4 py-6">
            <Outlet />
          </div>
        </div>
      )}
    </CenterHeaderHost>
  )
}

function Main() {
  const snapshot = useSyncExternalStore(centerColumn.subscribe, centerColumn.snapshot, centerColumn.snapshot)
  const entry = [...snapshot.entries].sort((a, b) => a.order - b.order)[0]
  return (
    <main id="content" {...{ [DIALOG_COLUMN]: "" }} className="flex min-h-0 flex-1 flex-col">
      {entry ? <entry.component /> : <CenterPage />}
    </main>
  )
}

export const register = () => {
  layoutParams.register({ id: "shell.sidebar", keys: [SIDEBAR] })
  layoutParams.register({ id: "shell.columnWidths", keys: Object.values(WIDTH_PARAMS) })
  centerHeaders.register({ id: "shell.center-header", order: 10, component: CenterHeaderFrame })
  routes.register({ id: "app", parent: "root", component: AppShell })
  sidebarToggle.register({ id: "sidebar-toggle", order: 10, component: SidebarToggle })
}
