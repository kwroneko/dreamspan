// A chat's next request, as a request inspector tab (owner, 2026-11-23: View request opens it the
// way every other request inspector opens). Its URL names the chat, and the branch tip and fork
// it was opened at, and the opening workbench tab; its context chip publishes where the chat
// stands now and its estimate's revision, so the tab is built again when the estimate changes (a new
// message, a swipe, a saved edit, a settings change). Built with `GetNextRequest`: assembled and
// counted locally, nothing asked of a provider.
import type { ChatId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"

export const NEXT_REQUEST_PATH = "/request/next"

/** Where a next-request URL points: the chat, and the tip and fork it was opened at. */
export const nextRequestOf = (search: {
  readonly chat?: unknown
  readonly leaf?: unknown
  readonly fork?: unknown
  readonly chatTab?: unknown
}) => ({
  chat: typeof search.chat === "string" && search.chat !== "" ? (search.chat as ChatId) : null,
  leaf: typeof search.leaf === "string" && search.leaf !== "" ? (search.leaf as SlotId) : null,
  fork: typeof search.fork === "string" && search.fork !== "" ? (search.fork as ForkId) : null,
  chatTab: typeof search.chatTab === "string" && search.chatTab !== "" ? search.chatTab : null
})

/** The URL of a chat's next request, opened at `leaf` on `fork`. */
export const nextRequestHref = (chat: ChatId, leaf: string | null, fork: string | null, chatTab: string | null) =>
  `${NEXT_REQUEST_PATH}?${new URLSearchParams({
    chat,
    ...(leaf === null ? {} : { leaf }),
    ...(fork === null ? {} : { fork }),
    ...(chatTab === null ? {} : { chatTab })
  }).toString()}`

/** The tab kind's item: one next request per chat. */
export const nextRequestKey = (url: URL) => `next:${url.searchParams.get("chat") ?? ""}`

/** Where a chat's open view stands, as its context chip publishes it. */
export interface NextRequestAt {
  readonly leaf: SlotId | null
  readonly fork: ForkId | null
  /** The estimate's revision: a change builds the request again. */
  readonly revision: number
}

const published = new Map<symbol, { readonly chat: ChatId; readonly tab: string | null; readonly at: NextRequestAt }>()
const listeners = new Set<() => void>()
let version = 0
const changed = () => {
  version++
  for (const listener of listeners) listener()
}

export const nextRequests = {
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  },
  version: () => version,
  publish: (token: symbol, chat: ChatId, tab: string | null, at: NextRequestAt) => {
    const before = published.get(token)
    if (
      before &&
      before.chat === chat &&
      before.tab === tab &&
      before.at.leaf === at.leaf &&
      before.at.fork === at.fork &&
      before.at.revision === at.revision
    )
      return
    published.set(token, { chat, tab, at })
    changed()
  },
  withdraw: (token: symbol) => {
    if (published.delete(token)) changed()
  },
  /** Where the opening view stands now, if it still shows this chat. */
  find: (chat: ChatId, tab: string | null) =>
    [...published.values()].find((entry) => entry.chat === chat && entry.tab === tab)?.at ?? null
}
