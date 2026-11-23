// The first request of a chat not sent yet, as a request inspector tab (owner, 2026-11-23: like
// every other inspector). Its URL names the pending chat it belongs to (`pending`, that view's
// URL) and that view's tab (`pendingTab`): what the request holds is the pending chat's own
// choices (greetings drawn, persona, who replies, the text), which live in its view, so the view
// publishes its first request here (`useDraftPreview`'s state) and the tab reads it. Nothing is
// asked of a provider: the page only shows what the view built with `PreviewChat`.
import type { DraftPreviewState } from "./draftRequest.tsx"

export const FIRST_REQUEST_PATH = "/request/first"

/** The pending chat a first-request URL names: its path, and its tab when in a workbench. */
export const firstRequestOf = (search: { readonly pending?: unknown; readonly pendingTab?: unknown }) => {
  const pending = typeof search.pending === "string" && search.pending.startsWith("/") ? search.pending : null
  const tab = typeof search.pendingTab === "string" && search.pendingTab !== "" ? search.pendingTab : null
  return { pending, tab }
}

const pathOf = (href: string) => new URL(href, "http://tab.invalid").pathname

/** The tab kind's item: one request per pending chat's view. */
export const firstRequestKey = (url: URL) => {
  const { pending, tab } = firstRequestOf({
    pending: url.searchParams.get("pending") ?? undefined,
    pendingTab: url.searchParams.get("pendingTab") ?? undefined
  })
  return `first:${tab ?? ""}:${pending === null ? "" : pathOf(pending)}`
}

interface Published {
  readonly path: string
  readonly tab: string | null
  readonly draft: DraftPreviewState
}

const published = new Map<symbol, Published>()
const listeners = new Set<() => void>()
let version = 0
const changed = () => {
  version++
  for (const listener of listeners) listener()
}

export const firstRequests = {
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  },
  version: () => version,
  /** A pending chat's view says what its first request is now. */
  publish: (token: symbol, path: string, tab: string | null, draft: DraftPreviewState) => {
    const before = published.get(token)
    if (
      before &&
      before.path === pathOf(path) &&
      before.tab === tab &&
      before.draft.preview === draft.preview &&
      before.draft.loading === draft.loading &&
      before.draft.error === draft.error
    )
      return
    published.set(token, { path: pathOf(path), tab, draft })
    changed()
  },
  withdraw: (token: symbol) => {
    if (published.delete(token)) changed()
  },
  /** The request of the pending chat a URL names: its own tab's view, else any view of it. */
  find: (pending: string, tab: string | null) => {
    const path = pathOf(pending)
    const views = [...published.values()].filter((entry) => entry.path === path)
    return (views.find((entry) => entry.tab === tab) ?? views[0])?.draft ?? null
  }
}
