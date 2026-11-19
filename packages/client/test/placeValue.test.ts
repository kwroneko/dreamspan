// Place values written in one tick (usePlaceParam.ts `writePlaceValue`): both land, of one key
// or of two, also while the history lands each change only after asking its blocker, as a
// workbench tab's does (Workbench.tsx).
import { createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router"
import { afterEach, expect, it, vi } from "vitest"
import { writePlaceValue } from "../src/usePlaceParam.ts"

afterEach(() => vi.unstubAllGlobals())

const setup = (blocked: boolean) => {
  const history = createMemoryHistory({ initialEntries: ["/library/book"] })
  const router = createRouter({ routeTree: createRootRoute(), history, isServer: false, origin: "http://tab.invalid" })
  // As the mounted router does: each change of the history loads it.
  history.subscribe(() => void router.load())
  // The history asks blockers only where there is a document.
  if (blocked) vi.stubGlobal("document", {})
  if (blocked) history.block({ blockerFn: () => false, enableBeforeUnload: false })
  const length = history.length
  const landed = async () => {
    await new Promise((done) => setTimeout(done, 0))
    expect(history.length).toBe(length)
    return router.latestLocation.search as Record<string, unknown>
  }
  return { router, landed }
}

const add = (uid: number) => (current: unknown) => [...(Array.isArray(current) ? current : []), uid]

for (const blocked of [false, true]) {
  it(`two writes of one key in one tick both land${blocked ? ", behind a blocker" : ""}`, async () => {
    const { router, landed } = setup(blocked)
    writePlaceValue(router, "open", add(1))
    writePlaceValue(router, "open", add(2))
    expect((await landed()).open).toEqual([1, 2])
  })

  it(`writes of two keys in one tick both land${blocked ? ", behind a blocker" : ""}`, async () => {
    const { router, landed } = setup(blocked)
    writePlaceValue(router, "entry", () => "7")
    writePlaceValue(router, "open", add(7))
    expect(await landed()).toEqual({ entry: "7", open: [7] })
    // And a later tick builds on what landed; an unchanged value writes nothing.
    expect(writePlaceValue(router, "entry", () => "7")).toBe("unchanged")
    writePlaceValue(router, "open", () => undefined)
    expect(await landed()).toEqual({ entry: "7" })
  })
}
