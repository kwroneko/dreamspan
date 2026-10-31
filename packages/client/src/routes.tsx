// The route registry (spec/PLUGINS.md §8): every screen registers here by id, and the
// router is built from what's registered. A layout's navigation lists its children.
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  retainSearchParams,
  type AnyRoute
} from "@tanstack/react-router"
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
   */
  readonly nav?: {
    readonly label: string
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
      <h1 className="text-lg font-semibold">Nothing here</h1>
      <Link to="/" className="text-accent underline-offset-4 hover:underline">
        Back home
      </Link>
    </main>
  )
}

/** A router over the routes registered so far. */
export const buildRouter = () => {
  const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: NotFound })
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
            ? createRoute({ getParentRoute: () => parent, id: entry.id, component: entry.component, ...search })
            : createRoute({ getParentRoute: () => parent, path: entry.path, component: entry.component, ...search })
        const nested = children(entry.id, route)
        return nested.length > 0 ? route.addChildren(nested) : route
      })
  return createRouter({ routeTree: rootRoute.addChildren(children("root", rootRoute)) })
}
