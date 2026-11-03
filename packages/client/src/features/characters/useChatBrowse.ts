import { useEffect, useMemo, useState } from "react"
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router"
import { CHAT_FILTERS, CHAT_SORTS, type ChatBrowse } from "@rp/shared/chatBrowse.ts"
import { useSession } from "../../session.ts"

import { chatBrowseSearch } from "./chatBrowseSearch.ts"
const read = (value: Record<string, unknown>): ChatBrowse => ({
  filter: CHAT_FILTERS.find((v) => v === value.sideChatsShow) ?? "all",
  sort: CHAT_SORTS.find((v) => v === value.sideChatsSort) ?? "recent",
  reversed: value.sideChatsReverse === true
})
const write = (value: ChatBrowse) => ({
  sideChatsShow: value.filter === "all" ? undefined : value.filter,
  sideChatsSort: value.sort === "recent" ? undefined : value.sort,
  sideChatsReverse: value.reversed || undefined
})
declare module "@tanstack/react-router" {
  interface HistoryState {
    chatBrowse?: boolean
  }
}

/** URL wins; a fresh visit without choices is seeded from this account's browser memory. */
export function useChatBrowse() {
  const key = `rp.chats.sidebar.${useSession().user.id}`
  const [remembered, remember] = useState(() => {
    try {
      return read(JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>)
    } catch {
      return read({})
    }
  })
  const encoded = useSearch({
    strict: false,
    select: (s: Record<string, unknown>) => JSON.stringify(Object.fromEntries(chatBrowseSearch.map((k) => [k, s[k]])))
  })
  const search = useMemo(() => JSON.parse(encoded) as Record<string, unknown>, [encoded])
  const marked = useLocation({ select: (l) => l.state.chatBrowse === true })
  const navigate = useNavigate()
  const state = useMemo(
    () => (!marked && !chatBrowseSearch.some((k) => search[k] !== undefined) ? remembered : read(search)),
    [marked, search, remembered]
  )
  useEffect(() => {
    if (!marked)
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, ...write(state) }),
        state: (prev) => ({ ...prev, chatBrowse: true }),
        replace: true,
        resetScroll: false
      })
  }, [marked, navigate, state])
  const update = (change: Partial<ChatBrowse>) => {
    const next = {
      ...state,
      ...(change.sort !== undefined && change.sort !== state.sort ? { reversed: false } : {}),
      ...change
    }
    remember(next)
    try {
      localStorage.setItem(key, JSON.stringify(write(next)))
    } catch {
      /* URL still carries the choice. */
    }
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...write(next) }),
      state: (prev) => ({ ...prev, chatBrowse: true }),
      replace: true,
      resetScroll: false
    })
  }
  return [state, update] as const
}
