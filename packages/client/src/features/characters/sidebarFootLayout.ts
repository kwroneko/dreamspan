export type FootKind = "branch" | "split"
export type FootPresence = Record<FootKind, "list" | "header" | "absent">
const FOOT_HEADER = 41
// Two standard rows, including the header and the list's 4px row gap. Related chats' rows
// carry a relation line, and each of its two groups a caption (splitsection).
export const FOOT_DEFAULT = { branch: 221, split: 356 }
// Allow a complete row even with stacked portraits or a wrapped date (and, for Related
// chats, its group's caption above it).
export const FOOT_MIN = { branch: 147, split: 231 }

/** Chats owns the remainder; short columns shrink lists before collapsing them. */
export function sidebarFootLayout(
  available: number,
  preferred: Record<FootKind, number>,
  expanded: Record<FootKind, boolean>,
  presence: FootPresence
) {
  const collapsed = {
    branch: !expanded.branch || presence.branch !== "list",
    split: !expanded.split || presence.split !== "list"
  }
  const closedHeight = (kind: FootKind) => (presence[kind] === "absent" ? 0 : FOOT_HEADER)
  const minimum = (kind: FootKind) => (collapsed[kind] ? closedHeight(kind) : FOOT_MIN[kind])
  const gap = presence.branch !== "absent" && presence.split !== "absent" ? 8 : 0
  for (const kind of ["split", "branch"] as const)
    if (minimum("branch") + gap + minimum("split") > available) collapsed[kind] = true
  const height = {
    branch: collapsed.branch ? closedHeight("branch") : Math.max(FOOT_MIN.branch, preferred.branch),
    split: collapsed.split ? closedHeight("split") : Math.max(FOOT_MIN.split, preferred.split)
  }
  for (const kind of ["split", "branch"] as const) {
    const excess = Math.max(0, height.branch + gap + height.split - available)
    height[kind] -= Math.min(excess, height[kind] - minimum(kind))
  }
  return {
    height,
    collapsed,
    total: height.branch + gap + height.split,
    max: {
      branch: Math.max(FOOT_MIN.branch, available - minimum("split") - gap),
      split: Math.max(FOOT_MIN.split, available - minimum("branch") - gap)
    }
  }
}
