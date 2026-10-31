import { expect, it } from "vitest"
import { routes } from "../src/routes.tsx"
import { settingsGroups, settingsNav } from "../src/features/settings/groups.ts"

const Page = () => null
const page = (id: string, order: number, nav: { adminOnly?: boolean; group?: string } = {}) =>
  routes.register({ id, parent: "settings", path: id, component: Page, nav: { label: id, order, ...nav } })

const shown = (isAdmin: boolean) =>
  settingsNav(isAdmin).map(({ group, pages }) => [group.label, pages.map((entry) => entry.id)])

it("lists settings pages under their groups: claimed by a group, named by the page, else under More", () => {
  const undo = [
    settingsGroups.register({ id: "models", label: "Models", order: 10, pages: ["t.keys", "t.connections"] }),
    settingsGroups.register({ id: "admin", label: "Admin", order: 40, pages: ["t.status"] }),
    page("t.status", 80),
    page("t.keys", 20),
    page("t.connections", 10),
    page("t.network", 30, { adminOnly: true, group: "models" }),
    page("t.plugin", 5)
  ]
  expect(shown(true)).toEqual([
    ["Models", ["t.connections", "t.keys", "t.network"]],
    ["Admin", ["t.status"]],
    ["More", ["t.plugin"]]
  ])
  expect(shown(false)).toEqual([
    ["Models", ["t.connections", "t.keys"]],
    ["Admin", ["t.status"]],
    ["More", ["t.plugin"]]
  ])

  // A plugin adds a group and moves a page into it; disabling a group sends its pages to More.
  const added = settingsGroups.register({ id: "tools", label: "Tools", order: 15 })
  const moved = page("t.plugin", 5, { group: "tools" })
  const hidden = settingsGroups.disable("admin")
  expect(shown(true)).toEqual([
    ["Models", ["t.connections", "t.keys", "t.network"]],
    ["Tools", ["t.plugin"]],
    ["More", ["t.status"]]
  ])
  for (const done of [hidden, moved, added, ...undo]) done()
  expect(shown(true)).toEqual([])
})
