// What the chat shows where summaries stand in for older messages (owner, 2026-11-18, DESIGN
// §10.1): two tabs, Messages and Summaries, hanging from the messages above them. Choosing one
// is this pane's own and the account's default for chats opened later (chatViewParams.ts).
// Shown at the boundary and above the chat's first message, only when summaries exist.
import { useEffect, useRef } from "react"
import { TabRow } from "../../ui/Tabs.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { useSummariesInChat } from "./chatViewParams.ts"

const TABS = [
  {
    value: "messages",
    label: "Messages",
    description: "Show the messages as they were written. Chats you open next start the same way."
  },
  {
    value: "summaries",
    label: "Summaries",
    description:
      "Show the summaries the model reads in place of older messages; each opens to its messages. Chats you open next start the same way."
  }
] as const

/**
 * The list is made again on a switch (ChatPage keys it by the mode) and placed anew, so the row
 * a keyboard or pointer chose from is gone. The focus goes back to the tab now chosen: in the
 * same row (boundary or start) when the new list shows it, else in the other row it shows. It
 * only ever takes a focus that is nowhere, never one the reader has put somewhere else.
 */
let refocus: { at: string; until: number } | null = null
const ORPHAN_MS = 400

export function SummaryTabs({ at }: { at: "start" | "boundary" }) {
  const viewer = useViewPrefs()
  const [on, setOn] = useSummariesInChat()
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // For a while after a choice, a row that mounts takes the focus while it's nowhere (the row
    // it was on is gone): the virtualizer may mount a row, drop it and mount it again as it
    // places the new list. The same row at once; the other row only if that one doesn't come.
    const take = () => {
      const lost = !document.activeElement || document.activeElement === document.body
      if (refocus && refocus.until >= Date.now() && lost && root.current?.isConnected)
        root.current.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true })
    }
    if (!refocus || refocus.until < Date.now()) return
    // After a frame: the tabs learn their places in the row in effects of their own, and a tab
    // focused before that leaves the arrow keys nowhere to go from.
    const timer = refocus.at === at ? setTimeout(() => requestAnimationFrame(take), 0) : setTimeout(take, ORPHAN_MS)
    return () => clearTimeout(timer)
  }, [at])
  const choose = (value: string) => {
    if (root.current?.contains(document.activeElement)) refocus = { at, until: Date.now() + 2000 }
    setOn(value === "summaries")
  }
  return (
    <div ref={root} data-testid="summary-tabs" data-at={at} className="flex w-full flex-col items-center text-sm">
      <TabRow
        label="Show in chat"
        hang="up"
        align="center"
        className="w-full"
        tabs={TABS}
        value={on ? "summaries" : "messages"}
        onValueChange={choose}
      />
      {viewer.error && (
        <p role="alert" className="text-danger">
          {viewer.error.message}
        </p>
      )}
    </div>
  )
}
