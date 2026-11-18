// How a pane shows a chat: "Summaries in chat" and the coverage rail (owner, 2026-11-18, DESIGN
// §10.1: "you should be able to have the same chat in one pane with summaries visible, and the
// actual chat side by side to compare"). Each is the pane's own, a place param in its URL (the
// browser's URL for a lone pane, its entry in the workbench's `wb` beside others), so a reload or
// a copied link shows it again, and no other pane or browser tab follows it.
//
// A sticky default (owner, same day: "the default should probably be saved per account, and be
// switched whenever you flip the switch, but only apply to newly opened panes/chats"): a chat
// opened without the param starts from the account's choice (DisplayPrefs `timeline`,
// `coverageRail`) and writes it into its URL at once, so a later flip elsewhere leaves it be;
// flipping the switch sets the pane's and the account's default together.
import { useParams, useRouter } from "@tanstack/react-router"
import { useEffect } from "react"
import { usePlaceValue } from "../../usePlaceParam.ts"
import { useViewPrefs } from "../../ui/viewPrefs.ts"

/** "Summaries in chat": `timeline=summaries` or `timeline=originals`. */
export const TIMELINE_PARAM = "timeline"
/** The coverage rail beside the messages: `rail=on` or `rail=off`. */
export const RAIL_PARAM = "rail"

/**
 * What each pane (its router) last showed for a chat, so a navigation within the chat that
 * drops the param (a message link) puts the pane's own back, not the account's default.
 */
const shown = new WeakMap<object, Map<string, boolean>>()

const usePaneSwitch = (
  param: string,
  values: readonly [on: string, off: string],
  fallback: boolean,
  ready: boolean,
  seed: boolean,
  saveDefault: (on: boolean) => void
) => {
  const router = useRouter()
  const { chatId } = useParams({ strict: false }) as { chatId?: string }
  const [raw, setRaw] = usePlaceValue(param)
  const memoryKey = `${chatId ?? ""}:${param}`
  const memory = shown.get(router) ?? new Map<string, boolean>()
  if (!shown.has(router)) shown.set(router, memory)
  const own = raw === values[0] ? true : raw === values[1] ? false : null
  const on = own ?? memory.get(memoryKey) ?? fallback
  if (own !== null) memory.set(memoryKey, own)
  useEffect(() => {
    // A chat opened without it: the pane takes what it shows now into its URL.
    // Once the account's default has loaded, so a pane never fixes the built-in one by mistake.
    if (seed && own === null && chatId !== undefined && ready) setRaw(() => values[on ? 0 : 1])
  }, [seed, own, on, chatId, ready, setRaw, values])
  const set = (next: boolean) => {
    memory.set(memoryKey, next)
    setRaw(() => values[next ? 0 : 1])
    saveDefault(next)
  }
  return [on, set] as const
}

const TIMELINE_VALUES = ["summaries", "originals"] as const
const RAIL_VALUES = ["on", "off"] as const

/**
 * This pane's "Summaries in chat", and its setter (which also sets the account's default).
 * `seed`: the chat summarizes (only then do the switches mean anything), so a pane opened
 * without the params writes them; a chat without summaries keeps its URL as it is.
 */
export const useSummariesInChat = (seed = false) => {
  const viewer = useViewPrefs()
  return usePaneSwitch(
    TIMELINE_PARAM,
    TIMELINE_VALUES,
    viewer.prefs.timeline === "summaries",
    viewer.ready,
    seed,
    (on) => {
      if ((viewer.prefs.timeline === "summaries") !== on)
        void viewer.change({ timeline: on ? "summaries" : "originals" })
    }
  )
}

/** This pane's coverage rail, and its setter (which also sets the account's default); `seed` as above. */
export const useCoverageRail = (seed = false) => {
  const viewer = useViewPrefs()
  return usePaneSwitch(RAIL_PARAM, RAIL_VALUES, viewer.prefs.coverageRail, viewer.ready, seed, (on) => {
    if (viewer.prefs.coverageRail !== on) void viewer.change({ coverageRail: on })
  })
}
