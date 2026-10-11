import { describe, expect, it } from "vitest"
import { makeRegistry } from "../src/registry.ts"
import { fullPath, navEntries, routes } from "../src/routes.tsx"

describe("registry", () => {
  it("overrides by id, and undoing a registration in any order restores what it hid", () => {
    const registry = makeRegistry<{ id: string; value: number }>()
    const undoA = registry.register({ id: "a", value: 1 })
    registry.register({ id: "b", value: 2 })
    const undoOverride = registry.register({ id: "a", value: 10 })
    const undoDisable = registry.disable("b")
    expect(registry.list()).toEqual([{ id: "a", value: 10 }])

    undoA()
    expect(registry.get("a")).toEqual({ id: "a", value: 10 })
    undoDisable()
    expect(registry.list().map((entry) => entry.value)).toEqual([10, 2])
    undoOverride()
    expect(registry.get("a")).toBeUndefined()
    expect(registry.list().map((entry) => entry.id)).toEqual(["b"])
  })

  it("builds paths from parents, and lists a layout's navigation in order, admin entries for admins", () => {
    const Page = () => null
    const undo = [
      routes.register({ id: "t.app", parent: "root", component: Page }),
      routes.register({ id: "t.settings", parent: "t.app", path: "/t-settings", component: Page }),
      routes.register({ id: "t.b", parent: "t.settings", path: "b", component: Page, nav: { label: "B", order: 2 } }),
      routes.register({
        id: "t.a",
        parent: "t.settings",
        path: "a/$id",
        component: Page,
        nav: { label: "A", order: 1, adminOnly: true }
      })
    ]
    expect(fullPath(routes.get("t.a")!)).toBe("/t-settings/a/$id")
    expect(navEntries("t.settings", true).map((entry) => entry.id)).toEqual(["t.a", "t.b"])
    expect(navEntries("t.settings", false).map((entry) => entry.id)).toEqual(["t.b"])
    for (const done of undo) done()
    expect(navEntries("t.settings", true)).toEqual([])
  })
})
