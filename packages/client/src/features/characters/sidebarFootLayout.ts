export type FootKind = "branch" | "split"
const FOOT_HEADER = 41
// Three standard rows, including the header and the list's 4px row gaps.
export const FOOT_DEFAULT = { branch: 311, split: 335 }
// Allow a complete row even with stacked portraits or a wrapped date.
export const FOOT_MIN = { branch: 147, split: 211 }

/** Reserved slots depend on the column and user choices, never on chat contents. */
export function sidebarFootLayout(
  available: number,
  preferred: Record<FootKind, number>,
  expanded: Record<FootKind, boolean>
) {
  const height = {
    branch: expanded.branch ? Math.max(FOOT_MIN.branch, preferred.branch) : FOOT_HEADER,
    split: expanded.split ? Math.max(FOOT_MIN.split, preferred.split) : FOOT_HEADER
  }
  const collapsed = { branch: !expanded.branch, split: !expanded.split }
  for (const kind of ["split", "branch"] as const)
    if (height.branch + 8 + height.split > available) {
      height[kind] = FOOT_HEADER
      collapsed[kind] = true
    }
  return {
    height,
    collapsed,
    total: height.branch + 8 + height.split,
    max: {
      branch: Math.max(FOOT_MIN.branch, available - height.split - 8),
      split: Math.max(FOOT_MIN.split, available - height.branch - 8)
    }
  }
}
