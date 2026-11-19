import { useMemo } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { CHAT_FILTERS, CHAT_SORTS, type ChatBrowse } from "@dreamspan/shared/chatBrowse.ts"

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
/** Each tab reads only its URL, including defaults on an unqualified visit. */
export function useChatBrowse() {
  const encoded = useSearch({
    strict: false,
    select: (s: Record<string, unknown>) => JSON.stringify(Object.fromEntries(chatBrowseSearch.map((k) => [k, s[k]])))
  })
  const search = useMemo(() => JSON.parse(encoded) as Record<string, unknown>, [encoded])
  const navigate = useNavigate()
  const state = useMemo(() => read(search), [search])
  const update = (change: Partial<ChatBrowse>) => {
    const next = {
      ...state,
      ...(change.sort !== undefined && change.sort !== state.sort ? { reversed: false } : {}),
      ...change
    }
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...write(next) }),
      replace: true,
      resetScroll: false
    })
  }
  return [state, update] as const
}
