// Where the path shown branches (DESIGN §3.2): the messages on it that have alternates, so
// the header can say which branch this is from anywhere in the chat, not only when the
// message where it branched is loaded. The path is read once per branch shown, from its
// leaf up, a page at a time; what's loaded since (a reply, a new branch) is merged in.
import type { PathEntry, SlotId } from "@rp/shared/chat.ts"
import { useEffect, useState } from "react"
import { useAction } from "../../actions.tsx"
import type { ChatSession, ChatView } from "./session.ts"

/** How far up the path the header looks for where it branched. */
export const FORK_SCAN_LIMIT = 2000
const PAGE = 500

interface Scan {
  readonly leaf: SlotId
  readonly forks: ReadonlyArray<PathEntry>
  /** It reached the first message. */
  readonly complete: boolean
}

export interface Forks {
  /** The messages on the path with alternates, first to last. */
  readonly forks: ReadonlyArray<PathEntry>
  /** The whole path was looked at (else only its last FORK_SCAN_LIMIT messages). */
  readonly complete: boolean
}

export function useForks(session: ChatSession, view: ChatView): Forks {
  const action = useAction()
  const [scan, setScan] = useState<Scan | null>(null)
  const leaf = view.leafSlotId
  // A scan stays good while its leaf is still on the path shown: the path only grew below it.
  const current = scan !== null && (scan.leaf === leaf || view.entries.some((e) => e.slotId === scan.leaf))
  useEffect(() => {
    if (leaf === null || current) return
    let live = true
    void (async () => {
      const found: Array<PathEntry> = []
      let range: { _tag: "Bottom" } | { _tag: "Older"; from: SlotId } = { _tag: "Bottom" }
      for (let read = 0; read < FORK_SCAN_LIMIT; read += PAGE) {
        const result = await action.run((client) =>
          client("ReadPath", { chatId: session.id, leafSlotId: leaf, range, limit: PAGE })
        )
        if (!live || !result.ok) return
        found.unshift(...result.value.entries.filter((e) => e.branchCount > 1))
        const older = result.value.older
        if (older === null) return setScan({ leaf, forks: found, complete: true })
        range = { _tag: "Older", from: older }
      }
      setScan({ leaf, forks: found, complete: false })
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `action` is a new object each render
  }, [leaf, current, session])
  if (scan === null || !current) {
    return { forks: view.entries.filter((e) => e.branchCount > 1), complete: false }
  }
  // What's loaded is newer than the scan: it replaces the scan's entry at its depth.
  const loaded = new Map(view.entries.map((e) => [e.depth, e]))
  const byDepth = new Map(scan.forks.map((e) => [e.depth, e]))
  for (const [depth, entry] of loaded) byDepth.set(depth, entry)
  const forks = [...byDepth.values()].filter((e) => e.branchCount > 1).sort((a, b) => a.depth - b.depth)
  return { forks, complete: scan.complete }
}
