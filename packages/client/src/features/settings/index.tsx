// Settings: its pages are the "settings" route's children, listed in groups. On a wide screen
// the groups are a column beside the open page; on a phone /settings is the list and each page
// opens on its own, with a way back to the list.
import { Link, Navigate, Outlet, useLocation } from "@tanstack/react-router"
import { useSyncExternalStore } from "react"
import { fullPath, routes } from "../../routes.tsx"
import { useSession } from "../../session.ts"
import { Icon } from "../../ui/Icon.tsx"
import { useTitle } from "../shell.tsx"
import { settingsGroups, settingsNav } from "./groups.ts"

// Tailwind's `md`: where the list sits beside the page.
const WIDE = "(min-width: 768px)"
const subscribeWide = (listener: () => void) => {
  const query = matchMedia(WIDE)
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}
const useWide = () => useSyncExternalStore(subscribeWide, () => matchMedia(WIDE).matches)

/** The groups and pages this user sees, again whenever a group is registered or removed. */
const useSettingsNav = () => {
  const session = useSession()
  useSyncExternalStore(settingsGroups.subscribe, settingsGroups.snapshot)
  return settingsNav(session.user.role === "admin")
}

function SettingsNavigation() {
  const sections = useSettingsNav()
  return (
    <nav aria-label="Settings" className="flex flex-col gap-5 md:gap-4">
      {sections.map(({ group, pages }) => (
        <section key={group.id} aria-labelledby={`settings-group-${group.id}`} className="flex flex-col gap-1.5">
          <h2 id={`settings-group-${group.id}`} className="px-3 text-xs font-medium tracking-wide text-muted uppercase">
            {group.label}
          </h2>
          {/* A phone's list is a card of rows; a wide screen's is a column of links. */}
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface md:divide-y-0 md:rounded-none md:border-0 md:bg-transparent">
            {pages.map((entry) => (
              <li key={entry.id}>
                <Link
                  to={fullPath(entry)}
                  className="flex items-center gap-2 px-4 py-3 text-text hover:bg-surface-raised md:rounded-md md:px-3 md:py-1.5 md:text-sm md:text-muted md:hover:text-text md:data-[status=active]:bg-surface-raised md:data-[status=active]:font-medium md:data-[status=active]:text-text"
                >
                  <span className="min-w-0 flex-1 truncate">{entry.nav!.label}</span>
                  <Icon name="right" className="text-muted md:hidden" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  )
}

function SettingsLayout() {
  useTitle("Settings")
  const pathname = useLocation({ select: (location) => location.pathname })
  const atList = /^\/settings\/?$/.test(pathname)
  // The open page's own name, for a phone, where the list isn't beside it.
  const open = useSettingsNav()
    .flatMap((section) => section.pages)
    .find((entry) => pathname === fullPath(entry) || pathname.startsWith(`${fullPath(entry)}/`))
  return (
    <div className="flex flex-col gap-4 md:flex-row md:gap-8">
      <div className={`md:sticky md:top-0 md:block md:w-48 md:shrink-0 md:self-start ${atList ? "" : "hidden"}`}>
        <h1 className="mb-4 px-1 text-lg font-semibold md:hidden">Settings</h1>
        <SettingsNavigation />
      </div>
      <div className={`min-w-0 flex-1 ${atList ? "hidden md:block" : ""}`}>
        {!atList && (
          <div className="mb-4 flex flex-col items-start gap-1 md:hidden">
            <Link
              to="/settings"
              className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-sm text-muted hover:text-text"
            >
              <Icon name="back" />
              Settings
            </Link>
            {open && <h1 className="px-1 text-lg font-semibold">{open.nav!.label}</h1>}
          </div>
        )}
        <Outlet />
      </div>
    </div>
  )
}

/** /settings: on a phone the list is the page; beside it, the first page opens. */
function SettingsIndex() {
  const wide = useWide()
  const [first] = useSettingsNav().flatMap((section) => section.pages)
  return wide && first ? <Navigate to={fullPath(first)} replace /> : null
}

export const register = () => {
  routes.register({
    id: "settings",
    parent: "app",
    path: "/settings",
    component: SettingsLayout,
    nav: { label: "Settings", order: 90 }
  })
  routes.register({ id: "settings.index", parent: "settings", path: "/", component: SettingsIndex })
  settingsGroups.register({
    id: "models",
    label: "Models",
    order: 10,
    pages: ["settings.connections", "settings.credentials", "settings.network", "settings.costs"]
  })
  // Regex scripts: the account's global scripts (a page of its own feature).
  settingsGroups.register({
    id: "chatting",
    label: "Chatting",
    order: 20,
    pages: ["settings.chats", "settings.display", "settings.regex", "settings.notifications"]
  })
  settingsGroups.register({ id: "account", label: "Account", order: 30, pages: ["settings.account", "settings.users"] })
  settingsGroups.register({ id: "admin", label: "Admin", order: 40, pages: ["settings.status"] })
}
