import { Tooltip } from "./ui/Tooltip.tsx"
import { appBanners } from "./features/shell.tsx"
import { SlotOutlet } from "./slots.tsx"
// The route registry (spec/PLUGINS.md §8): every screen registers here by id, and the
// router is built from what's registered. A layout's navigation lists its children.
import {
  createRootRoute,
  createRoute,
  createRouter,
  ErrorComponent,
  Link,
  type ErrorComponentProps,
  Outlet,
  retainSearchParams,
  type AnyRoute,
  type RouterHistory
} from "@tanstack/react-router"
import type { IconName } from "./ui/Icon.tsx"
import { useEffect, type ReactNode } from "react"
import { isChunkLoadError, reportChunkFailure, StalePart, useStaleBuild } from "./staleBuild.tsx"
import { makeRegistry } from "./registry.ts"
import { layoutKeys, setLayoutHistory, withLayoutParams } from "./tabLayoutParams.ts"

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
  /**
   * The screen fills the height below the header and scrolls inside itself, as a chat does
   * (its composer anchored to the bottom); without it the screen scrolls as a page. Declared
   * by the route, so a screen added later (a plugin's too) can't fall out of a path list.
   */
  readonly fill?: boolean
  /**
   * Under the column header, the screen fills the height and scrolls inside itself: a text box
   * taking a tab's whole height (a field's own tab), as an editor opened from a chat does.
   */
  readonly fillBelowHeader?: boolean
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** RouteEntry.fill. */
    fill?: boolean
    /** RouteEntry.fillBelowHeader. */
    fillBelowHeader?: boolean
  }
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

/** A screen that failed: a page whose code is gone after a rebuild asks for a reload. */
function RouteError({ error }: ErrorComponentProps) {
  const stale = useStaleBuild()
  useEffect(() => {
    void reportChunkFailure(error)
  }, [error])
  if (stale || isChunkLoadError(error))
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-2 p-6">
        <SlotOutlet slot={appBanners} props={{}} />
        {stale ? <StalePart /> : <ErrorComponent error={error} />}
      </main>
    )
  return <ErrorComponent error={error} />
}

/**
 * Leaves the browser tab's layout params (`tabLayoutParams.ts`) out of every location the
 * browser's router builds, so a link's address carries none (opened in a new browser tab, it
 * starts from the defaults). A navigation in this tab gets them back as it's committed
 * (`buildRouter`), so it lands with the layout, and a link to where the tab already is stays
 * the same place rather than a new history entry.
 */
const withoutLayout = ({
  search,
  next
}: {
  search: Record<string, unknown>
  next: (search: Record<string, unknown>) => Record<string, unknown>
}) => {
  const result = next(search)
  const keys = layoutKeys()
  if (!Object.keys(result).some((key) => keys.has(key))) return result
  return Object.fromEntries(Object.entries(result).filter(([key]) => !keys.has(key)))
}

/**
 * A router over the routes registered so far. A workbench tab (features/workbench) has its
 * own, over its own history, with the shell's layout entries swapped for its page frame; the
 * one without a history is the browser tab's, whose URL holds the layout params (tabLayoutParams.ts).
 */
export const buildRouter = (
  options: { history?: RouterHistory; layouts?: Readonly<Record<string, () => ReactNode>> } = {}
) => {
  const rootRoute = createRootRoute({
    component: Outlet,
    notFoundComponent: NotFound,
    search: {
      middlewares: options.history
        ? [retainSearchParams(["plugins"])]
        : [retainSearchParams(["plugins"]), withoutLayout]
    }
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
        const shared = {
          component: component(entry),
          staticData: { fill: entry.fill === true, fillBelowHeader: entry.fillBelowHeader === true },
          ...search
        }
        const route =
          entry.path === undefined
            ? createRoute({ getParentRoute: () => parent, id: entry.id, ...shared })
            : createRoute({ getParentRoute: () => parent, path: entry.path, ...shared })
        const nested = children(entry.id, route)
        return nested.length > 0 ? route.addChildren(nested) : route
      })
  const router = createRouter({
    defaultErrorComponent: RouteError,
    routeTree: rootRoute.addChildren(children("root", rootRoute)),
    ...(options.history ? { history: options.history } : {})
  })
  if (!options.history) {
    setLayoutHistory(router.history)
    const commit = router.commitLocation
    router.commitLocation = (next) => {
      const href = withLayoutParams(next.href)
      const publicHref = withLayoutParams(next.publicHref)
      if (href === next.href && publicHref === next.publicHref) return commit(next)
      return commit({ ...next, href, publicHref, searchStr: new URL(href, "http://tab.invalid").search })
    }
  }
  return router
}
