// Where a message is on the fork's display path (spec/MESSAGE-INSERT.md §2.3): its position,
// from 0 at the first message. It numbers messages (#n) and is what the server's positions are
// compared with: the history start, summaries' ranges and the LCM cursor, search hits. `depth`
// stays structural (paging, branches). A window of a fork without insertions carries no
// positions, and there a position is the depth.
import type { PathEntry } from "@rp/shared/chat.ts"
import type { LcmState } from "@rp/shared/lcm.ts"

export const positionOf = (entry: Pick<PathEntry, "position" | "depth">): number => entry.position ?? entry.depth

/** The last position the summaries in use cover (-1: none): what messages' positions are compared with. */
export const lcmCursor = (lcm: Pick<LcmState, "cursorDepth" | "cursorPosition">): number =>
  lcm.cursorPosition ?? lcm.cursorDepth
