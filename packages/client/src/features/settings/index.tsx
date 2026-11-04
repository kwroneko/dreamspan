// Settings: its pages are the "settings" route's children, listed in groups. On a wide screen
// the groups are a column beside the open page; on a phone /settings is the list and each page
// opens on its own, with a way back to the list.
import { Link, Navigate, Outlet, useLocation } from "@tanstack/react-router"
import { useId, useSyncExternalStore } from "react"
import { fullPath, routes, type RouteEntry } from "../../routes.tsx"
import { useSession } from "../../session.ts"
import { Icon } from "../../ui/Icon.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
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

/**
 * A page's link: its description under its label on a phone; on a wide screen its tooltip,
 * beside the list, with a hidden copy outside the link as its description, so the link's text
 * stays its label.
 */
function NavLink({ entry, wide }: { entry: RouteEntry; wide: boolean }) {
  const { label, description } = entry.nav!
  const id = useId()
  // Hidden from its name, and still its description: a reference reads hidden text.
  const explanation = description && (
    <span id={id} aria-hidden="true" className={wide ? "hidden" : "pt-0.5 text-xs text-muted"}>
      {description}
    </span>
  )
  const link = (
    <Link
      to={fullPath(entry)}
      {...(description ? { "aria-describedby": id } : {})}
      className="flex items-center gap-2 px-4 py-3 text-text hover:bg-surface-raised md:rounded-md md:px-3 md:py-1.5 md:text-sm md:text-muted md:hover:text-text md:data-[status=active]:bg-surface-raised md:data-[status=active]:font-medium md:data-[status=active]:text-text"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{label}</span>
        {!wide && explanation}
      </span>
      <Icon name="right" className="text-muted md:hidden" />
    </Link>
  )
  return description && wide ? (
    <>
      <Tooltip label={description} side="right">
        {link}
      </Tooltip>
      {explanation}
    </>
  ) : (
    link
  )
}

function SettingsNavigation() {
  const sections = useSettingsNav()
  const wide = useWide()
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
                <NavLink entry={entry} wide={wide} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  )
}

/** The list's title. Only at the list: a layout's effect runs after its page's, and would replace the page's own. */
function ListTitle() {
  useTitle("Settings")
  return null
}

function SettingsLayout() {
  const pathname = useLocation({ select: (location) => location.pathname })
  const atList = /^\/settings\/?$/.test(pathname)
  // On a phone, where the list isn't beside it: the open page's name under the way back to the
  // list, or, on a page inside one (a connection), the way back to that page.
  const path = pathname.replace(/\/$/, "")
  const open = useSettingsNav()
    .flatMap((section) => section.pages)
    .find((entry) => path === fullPath(entry) || path.startsWith(`${fullPath(entry)}/`))
  const inside = open !== undefined && path !== fullPath(open)
  return (
    <div className="flex flex-col gap-4 md:flex-row md:gap-8">
      {atList && <ListTitle />}
      <div className={`md:sticky md:top-0 md:block md:w-48 md:shrink-0 md:self-start ${atList ? "" : "hidden"}`}>
        <h1 className="mb-4 px-1 text-lg font-semibold md:hidden">Settings</h1>
        <SettingsNavigation />
      </div>
      <div className={`min-w-0 flex-1 ${atList ? "hidden md:block" : ""}`}>
        {open && (
          <div className="mb-4 flex flex-col items-start gap-1 md:hidden">
            <Link
              to={inside ? fullPath(open) : "/settings"}
              className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-sm text-muted hover:text-text"
            >
              <Icon name="back" />
              {inside ? open.nav!.label : "Settings"}
            </Link>
            {!inside && <h1 className="px-1 text-lg font-semibold">{open.nav!.label}</h1>}
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
    nav: { label: "Settings", icon: "sliders", description: "Change your account and app preferences.", order: 90 }
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
  // Server status is the admins' (with its diagnostics); anyone else finds its plain part
  // under Account, so they never see an Admin heading.
  settingsGroups.register({
    id: "account",
    label: "Account",
    order: 30,
    pages: ["settings.account", "settings.users", "settings.status"]
  })
  settingsGroups.register({ id: "admin", label: "Admin", order: 40, adminOnly: true, pages: ["settings.status"] })
}
