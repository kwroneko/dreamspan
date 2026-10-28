import { describe, expect, it, vi } from "vitest"
import { makeRegistry } from "../src/registry.ts"
import { fullPath, navEntries, routes } from "../src/routes.tsx"

describe("registry", () => {
  it("publishes stable captured entries and disablements before notifying mounted subscribers", () => {
    const registry = makeRegistry<{ id: string }>()
    const empty = registry.snapshot()
    expect(registry.snapshot()).toBe(empty)
    const seen = vi.fn(() => registry.snapshot())
    const unsubscribe = registry.subscribe(seen)
    const remove = registry.register({ id: "a" })
    const added = registry.snapshot()
    expect(seen.mock.results.at(-1)?.value).toBe(added)
    expect(added.entries).toEqual([{ id: "a" }])
    expect(added).not.toBe(empty)
    const restore = registry.disable("a")
    const disabled = registry.snapshot()
    expect(disabled.entries).toEqual([])
    expect(disabled.disabled.has("a")).toBe(true)
    expect(added.entries).toEqual([{ id: "a" }])
    expect(added.disabled.has("a")).toBe(false)
    restore()
    expect(registry.snapshot().entries).toEqual(added.entries)
    expect(registry.snapshot().disabled.has("a")).toBe(false)
    remove()
    remove()
    expect(seen).toHaveBeenCalledTimes(4)
    unsubscribe()
  })

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
