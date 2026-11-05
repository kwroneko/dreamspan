import { expect, it } from "vitest"
import { FOOT_DEFAULT, sidebarFootLayout } from "../src/features/characters/sidebarFootLayout.ts"
const expanded = { branch: true, split: true }
it("keeps both requested sizes when the column fits them", () => {
  expect(sidebarFootLayout(700, FOOT_DEFAULT, expanded).height).toEqual(FOOT_DEFAULT)
})
it("collapses split first, then branches, without shrinking the expanded sizes", () => {
  expect(sidebarFootLayout(400, FOOT_DEFAULT, expanded).height).toEqual({ branch: 311, split: 41 })
  expect(sidebarFootLayout(300, FOOT_DEFAULT, expanded).height).toEqual({ branch: 41, split: 41 })
})
it("restores saved sizes and manual collapse choices without writing either", () => {
  const preferred = { branch: 300, split: 330 }
  sidebarFootLayout(200, preferred, expanded)
  expect(sidebarFootLayout(700, preferred, expanded).height).toEqual(preferred)
  expect(sidebarFootLayout(700, preferred, { branch: true, split: false }).height).toEqual({ branch: 300, split: 41 })
  expect(preferred).toEqual({ branch: 300, split: 330 })
})
