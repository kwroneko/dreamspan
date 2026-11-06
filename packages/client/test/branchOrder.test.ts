// The header's branch menu lists branches as the left panel does (owner, 2026-11-04):
// pinned, then named, then the rest, each by last message, newest first.
import { expect, it } from "vitest"
import { branchGroup, orderBranches } from "../src/features/chat/forks.ts"

const fork = (id: string, at: number, extra: { pinnedAt?: number; name?: string } = {}) => ({
  id,
  createdAt: 0,
  endAt: at,
  pinnedAt: extra.pinnedAt ?? null,
  name: extra.name ?? null
})

it("orders pinned, then named, then the rest, each newest first", () => {
  const forks = [
    fork("old", 1),
    fork("named-old", 2, { name: "Harbor" }),
    fork("new", 9),
    fork("pinned-old", 3, { pinnedAt: 50 }),
    fork("named-new", 8, { name: "Lighthouse" }),
    fork("pinned-named", 7, { pinnedAt: 10, name: "Rescue" }),
    fork("blank-name", 5, { name: "" })
  ]
  expect(orderBranches(forks).map((f) => f.id)).toEqual([
    "pinned-named",
    "pinned-old",
    "named-new",
    "named-old",
    "new",
    "blank-name",
    "old"
  ])
  expect(branchGroup(forks[6]!)).toBe("other")
})
