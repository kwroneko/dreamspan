// How this browser tab shows chats (owner, 2026-11-18: how a tab shows something is that tab's,
// in its URL): layout params (`tabLayoutParams.ts`), carried over every navigation in the tab,
// absent at their defaults. Never the account's: another tab shows chats its own way.
import { CHAT_WIDTH } from "@rp/shared/chatApi.ts"
import { useLayoutNumber, useLayoutParam, writeLayoutParam } from "../../tabLayoutParams.ts"

/** The chat column's widest, in whole pixels (Chat width); absent at `CHAT_WIDTH.default`. */
export const CHAT_WIDTH_PARAM = "cw"
/** "Summaries in chat": `timeline=summaries`; absent shows the original messages. */
export const TIMELINE_PARAM = "timeline"
/** The coverage rail beside the messages: `rail=on`; absent, hidden. */
export const RAIL_PARAM = "rail"

export const CHAT_VIEW_PARAMS = [CHAT_WIDTH_PARAM, TIMELINE_PARAM, RAIL_PARAM] as const

/** The chat width this tab shows, within the slider's range. */
export const useChatWidth = () => {
  const saved = useLayoutNumber(CHAT_WIDTH_PARAM, CHAT_WIDTH.min)
  return saved === null ? CHAT_WIDTH.default : Math.min(CHAT_WIDTH.max, saved)
}

export const writeChatWidth = (width: number) =>
  writeLayoutParam(CHAT_WIDTH_PARAM, width === CHAT_WIDTH.default ? null : String(Math.round(width)))

export const useSummariesInChat = () => useLayoutParam(TIMELINE_PARAM) === "summaries"

export const writeSummariesInChat = (on: boolean) => writeLayoutParam(TIMELINE_PARAM, on ? "summaries" : null)

export const useCoverageRail = () => useLayoutParam(RAIL_PARAM) === "on"

export const writeCoverageRail = (on: boolean) => writeLayoutParam(RAIL_PARAM, on ? "on" : null)
