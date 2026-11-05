import { expect, it } from "vitest"
import {
  FOOT_DEFAULT,
  FOOT_MIN,
  sidebarFootLayout,
  type FootPresence
} from "../src/features/characters/sidebarFootLayout.ts"
const expanded = { branch: true, split: true }
const lists: FootPresence = { branch: "list", split: "list" }
it("uses two-row defaults when they fit", () => {
  expect(sidebarFootLayout(600, FOOT_DEFAULT, expanded, lists).height).toEqual(FOOT_DEFAULT)
})
it("shrinks lists before collapsing, always keeping a complete row", () => {
  const fit = sidebarFootLayout(400, FOOT_DEFAULT, expanded, lists)
  expect(fit.collapsed).toEqual({ branch: false, split: false })
  expect(fit.total).toBe(400)
  expect(fit.height.branch).toBeGreaterThanOrEqual(FOOT_MIN.branch)
  expect(fit.height.split).toBeGreaterThanOrEqual(FOOT_MIN.split)
  expect(sidebarFootLayout(300, FOOT_DEFAULT, expanded, lists).height).toEqual({ branch: 221, split: 41 })
  expect(sidebarFootLayout(180, FOOT_DEFAULT, expanded, lists).height).toEqual({ branch: 41, split: 41 })
})
it("gives header-only and absent sections' space back to Chats", () => {
  const both = sidebarFootLayout(600, FOOT_DEFAULT, expanded, lists)
  const parentOnly = sidebarFootLayout(600, FOOT_DEFAULT, expanded, { branch: "list", split: "header" })
  const absent = sidebarFootLayout(600, FOOT_DEFAULT, expanded, { branch: "list", split: "absent" })
  expect(parentOnly.height.split).toBe(41)
  expect(both.total - parentOnly.total).toBe(FOOT_DEFAULT.split - 41)
  expect(absent.total).toBe(221)
})
it("restores saved sizes and manual collapse choices without writing either", () => {
  const preferred = { branch: 300, split: 330 }
  sidebarFootLayout(200, preferred, expanded, lists)
  expect(sidebarFootLayout(700, preferred, expanded, lists).height).toEqual(preferred)
  expect(sidebarFootLayout(700, preferred, { branch: true, split: false }, lists).height).toEqual({
    branch: 300,
    split: 41
  })
  expect(preferred).toEqual({ branch: 300, split: 330 })
})
