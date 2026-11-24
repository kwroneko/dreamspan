// Tab kinds (owner rule: every feature a registered, replaceable part): what item a URL is,
// so the same chat or editor opens one tab, how its tab is labelled before the view names
// itself, and what of its URL is kept in the saved layout. A tab renders through the route
// registry (routes.tsx), so a kind needs no renderer of its own.
import type { IconName } from "../../ui/Icon.tsx"
import { makeRegistry } from "../../registry.ts"

export interface TabKind {
  readonly id: string
  /** Lower first; the first kind whose `match` answers decides. */
  readonly order: number
  /** The item this URL shows (a chat's id, say), or null when the URL isn't this kind's. */
  readonly match: (url: URL) => string | null
  /** The tab's title until its view names itself (`useTitle`). */
  readonly title?: (url: URL) => string
  readonly icon?: IconName
  /**
   * A document (a chat, an editor): typing in it keeps its preview tab open. Typing in a page's
   * forms and filters doesn't.
   */
  readonly document?: boolean
  /** The URL as saved in the layout, or null to leave the tab out of it. By default, as is. */
  readonly persist?: (url: URL) => string | null
  /** Query keys the saved URL needs to open this item when space is tight. */
  readonly essentialSearch?: ReadonlyArray<string>
  /**
   * Opens where a tab of its kind is showing (owner, 2026-11-23: the request inspector): a plain
   * open goes to the frame focused most recently whose shown tab is of this kind, not the
   * opener's, with the usual preview rules there. Open beside and new browser tabs don't.
   */
  readonly opensWhereShown?: boolean
}

export const tabKinds = makeRegistry<TabKind>()

const parse = (href: string) => new URL(href, "http://tab.invalid")

const kindOf = (url: URL) => {
  for (const kind of [...tabKinds.list()].sort((a, b) => a.order - b.order)) {
    const key = kind.match(url)
    if (key !== null) return { kind, key }
  }
  return null
}

/** The item a URL shows: one tab per item. Unclaimed pages are their path. */
export const itemKey = (href: string) => {
  const url = parse(href)
  const found = kindOf(url)
  return found ? `${found.kind.id}:${found.key}` : `page:${url.pathname}`
}

export const tabKind = (href: string) => kindOf(parse(href))?.kind

/** The kind an item's tab opens with, for `opensWhereShown` kinds (model.ts `affinity`); else null. */
export const affinityOf = (href: string) => {
  const kind = tabKind(href)
  return kind?.opensWhereShown ? kind.id : null
}

export const defaultTitle = (href: string) => {
  const url = parse(href)
  return kindOf(url)?.kind.title?.(url) ?? "Page"
}

export const persistHref = (href: string) => {
  const url = parse(href)
  const kind = kindOf(url)?.kind
  return kind?.persist ? kind.persist(url) : href
}

/** A smaller saved URL with the same item. Query-keyed kinds can name the keys they need. */
export const compactHref = (href: string) => {
  const url = parse(href)
  const found = kindOf(url)
  const essential = found?.kind.essentialSearch
  const search = new URLSearchParams()
  for (const [key, value] of url.searchParams) if (essential?.includes(key)) search.append(key, value)
  const compact = search.size === 0 ? url.pathname : `${url.pathname}?${search}`
  if (essential !== undefined || itemKey(compact) === itemKey(href)) return compact
  return `${url.pathname}${url.search}`
}

/** Shell search params (the left sidebar's place): the browser's own, never a tab's. */
export const shellSearchKeys = makeRegistry<{ readonly id: string; readonly keys: ReadonlyArray<string> }>()

export const shellKeys = () => new Set(shellSearchKeys.list().flatMap((entry) => entry.keys))
