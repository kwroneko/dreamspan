import { Tooltip } from "./ui/Tooltip.tsx"
import { appBanners } from "./features/shell.tsx"
import { SlotOutlet } from "./slots.tsx"
// The route registry (spec/PLUGINS.md §8): every screen registers here by id, and the
// router is built from what's registered. A layout's navigation lists its children.
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  retainSearchParams,
  type AnyRoute,
  type RouterHistory
} from "@tanstack/react-router"
import type { IconName } from "./ui/Icon.tsx"
import type { ReactNode } from "react"
import { makeRegistry } from "./registry.ts"

export interface RouteEntry {
  readonly id: string
  /** The entry this one nests under, rendered in its layout's `<Outlet />`; "root" is the top. */
  readonly parent: string
  /** Relative to the parent's path, with `$name` for parameters. None: a layout without a path. */
  readonly path?: string
  readonly component: () => ReactNode
  /**
   * Listed in the parent's navigation. Admin-only entries are hidden from others; the server
   * still decides. `group`: the heading it sits under, in a navigation that has them (settings).
   * `description`: what the screen is for, in a sentence, where the navigation explains its links
   * (settings: under the label on a phone, its tooltip beside the list on a wide screen).
   */
  readonly nav?: {
    readonly label: string
    readonly icon?: IconName
    readonly description?: string
    readonly order: number
    readonly adminOnly?: boolean
    readonly group?: string
  }
  /**
   * Search params a navigation to this screen keeps from the current URL unless it sets or
   * removes them itself: state of the shell that outlives the screen's own links.
   */
  readonly retainSearch?: ReadonlyArray<string>
}

export const routes = makeRegistry<RouteEntry>()

/** The URL of an entry: its path joined to its ancestors'. */
export const fullPath = (entry: RouteEntry): string => {
  const parent = entry.parent === "root" ? undefined : routes.get(entry.parent)
  const base = parent ? fullPath(parent) : ""
  if (entry.path === undefined) return base || "/"
  if (entry.path.startsWith("/")) return entry.path
  return `${base.replace(/\/$/, "")}/${entry.path}`
}

/** The children of a layout that appear in its navigation, in order. */
export const navEntries = (parent: string, isAdmin: boolean) =>
  routes
    .list()
    .filter((entry) => entry.parent === parent && entry.nav && (isAdmin || !entry.nav.adminOnly))
    .sort((a, b) => a.nav!.order - b.nav!.order)

function NotFound() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-2 p-6">
      <SlotOutlet slot={appBanners} props={{}} only="plugins.host" />
      <h1 className="text-lg font-semibold">Nothing here</h1>
      <Tooltip label="Returns to the home page.">
        <Link to="/" className="text-accent underline-offset-4 hover:underline">
          Back home
        </Link>
      </Tooltip>
    </main>
  )
}

/**
 * A router over the routes registered so far. A workbench tab (features/workbench) has its
 * own, over its own history, with the shell's layout entries swapped for its page frame.
 */
export const buildRouter = (
  options: { history?: RouterHistory; layouts?: Readonly<Record<string, () => ReactNode>> } = {}
) => {
  const rootRoute = createRootRoute({
    component: Outlet,
    notFoundComponent: NotFound,
    search: { middlewares: [retainSearchParams(["plugins"])] }
  })
  const component = (entry: RouteEntry) => options.layouts?.[entry.id] ?? entry.component
  const children = (parentId: string, parent: AnyRoute): Array<AnyRoute> =>
    routes
      .list()
      .filter((entry) => entry.parent === parentId)
      .map((entry) => {
        const search = entry.retainSearch
          ? { search: { middlewares: [retainSearchParams([...entry.retainSearch])] } }
          : {}
        const route =
          entry.path === undefined
            ? createRoute({ getParentRoute: () => parent, id: entry.id, component: component(entry), ...search })
            : createRoute({ getParentRoute: () => parent, path: entry.path, component: component(entry), ...search })
        const nested = children(entry.id, route)
        return nested.length > 0 ? route.addChildren(nested) : route
      })
  return createRouter({
    routeTree: rootRoute.addChildren(children("root", rootRoute)),
    ...(options.history ? { history: options.history } : {})
  })
}
