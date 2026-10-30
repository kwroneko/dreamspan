// Where the path shown branches (DESIGN §3.2): the messages on it that have alternates, so
// the header can say which branch this is from anywhere in the chat, not only when the
// message where it branched is loaded. The path is read once per branch shown, from its
// leaf up, a page at a time; what's loaded since (a reply, a new branch) is merged in.
import { positionOf } from "./position.ts"
import type { PathEntry, SlotId } from "@rp/shared/chat.ts"
import { useEffect, useState } from "react"
import { useAction } from "../../actions.tsx"
import type { ChatSession, ChatView } from "./session.ts"

/** How far up the path the header looks for where it branched. */
export const FORK_SCAN_LIMIT = 2000
const PAGE = 500

interface Scan {
  readonly forkId: ChatView["forkId"]
  readonly revision: number
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

/** A named branch stays manageable after its last sibling is deleted. */
const manageable = (entry: PathEntry) => entry.branchCount > 1 || entry.branchName !== undefined

export function useForks(session: ChatSession, view: ChatView): Forks {
  const action = useAction()
  const [scan, setScan] = useState<Scan | null>(null)
  const leaf = view.leafSlotId
  // Edits, deletions and insertions can change off-window branch points without moving the tip.
  const current =
    scan !== null &&
    scan.forkId === view.forkId &&
    scan.revision === view.pathRevision &&
    (scan.leaf === leaf || view.entries.some((e) => e.slotId === scan.leaf))
  useEffect(() => {
    if (leaf === null || current) return
    let live = true
    void (async () => {
      const found: Array<PathEntry> = []
      let range: { _tag: "Bottom" } | { _tag: "Older"; from: SlotId } = { _tag: "Bottom" }
      for (let read = 0; read < FORK_SCAN_LIMIT; read += PAGE) {
        const result = await action.run((client) =>
          client("ReadPath", { chatId: session.id, forkId: view.forkId, leafSlotId: leaf, range, limit: PAGE })
        )
        if (!live || !result.ok) return
        found.unshift(...result.value.entries.filter(manageable))
        const older = result.value.older
        if (older === null)
          return setScan({ leaf, forkId: view.forkId, revision: view.pathRevision, forks: found, complete: true })
        range = { _tag: "Older", from: older }
      }
      setScan({ leaf, forkId: view.forkId, revision: view.pathRevision, forks: found, complete: false })
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `action` is a new object each render
  }, [leaf, current, session, view.forkId, view.pathRevision])
  if (scan === null || !current) {
    return { forks: view.entries.filter(manageable), complete: false }
  }
  // What's loaded is newer than the scan: it replaces the scan's entry for its slot. (An
  // inserted message has the depth of the message after it, so depths don't key them.)
  const bySlot = new Map(scan.forks.map((e) => [e.slotId, e]))
  for (const entry of view.entries) bySlot.set(entry.slotId, entry)
  const forks = [...bySlot.values()]
    .map((entry) => {
      const live = view.branchNames.get(entry.slotId)
      return live !== undefined && live.rowVersion >= entry.rowVersion
        ? ({ ...entry, branchName: live.name, rowVersion: live.rowVersion } as PathEntry)
        : entry
    })
    .filter(manageable)
    .sort((a, b) => positionOf(a) - positionOf(b))
  return { forks, complete: scan.complete }
}
