import { readFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectSaveState, NOTHING_TO_SAVE, UNSAVED } from "./support/saveRevision.ts"

const server = serverPerFile(withAdmin)
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`unrelated prompt controls retain their render and callbacks: ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript(() => {
        interface Fiber {
          type: unknown
          flags: number
          memoizedProps?: Record<string, unknown>
          alternate?: { memoizedProps?: Record<string, unknown> }
          child?: Fiber
          sibling?: Fiber
        }
        const w = window as unknown as {
          __handleSeen: boolean
          __handleRenders: number
          __promptRenders: number
          __promptChanges: number
          __promptSeen: boolean
          __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown
        }
        let lastHandle: Fiber | undefined
        w.__handleSeen = false
        w.__handleRenders = 0
        w.__promptChanges = 0
        w.__promptRenders = 0
        w.__promptSeen = false
        w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
          supportsFiber: true,
          inject: () => 1,
          onCommitFiberRoot: (_id: unknown, root: { current: Fiber }) => {
            const visit = (fiber: Fiber | undefined) => {
              if (!fiber) return
              const props = fiber.memoizedProps,
                old = fiber.alternate?.memoizedProps
              if (
                typeof fiber.type !== "string" &&
                props?.label === "Main Prompt" &&
                typeof props.onToggle === "function"
              ) {
                w.__promptSeen = true
                if (old && (fiber.flags & 1) !== 0) w.__promptRenders++
                if (old && props.onToggle !== old.onToggle) w.__promptChanges++
              }
              const child = props?.children as { props?: Record<string, unknown> } | undefined
              if (
                typeof fiber.type !== "string" &&
                props?.label === "Moves this item within the list." &&
                child?.props?.["aria-label"] === "Move Main Prompt"
              ) {
                w.__handleSeen = true
                // A bailed-out subtree can retain PerformedWork from its last commit.
                // Count only a new work-in-progress fiber for this handle.
                if (old && fiber !== lastHandle && (fiber.flags & 1) !== 0) w.__handleRenders++
                lastHandle = fiber
              }
              visit(fiber.child)
              visit(fiber.sibling)
            }
            visit(root.current)
          },
          onCommitFiberUnmount: () => {}
        }
      })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const data = readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url))
      const response = await page.request.post(`${server().url}/library/import?name=synthetic-render.json`, {
        data,
        headers: { origin: server().url, "content-type": "application/octet-stream" }
      })
      expect(response.ok()).toBe(true)
      const refId = ((await response.json()) as { library: { ref: { id: string } } }).library.ref.id
      await page.goto(`${server().url}/library/${refId}`)
      await expectSaveState(page, NOTHING_TO_SAVE)
      await expect
        .poll(() =>
          page.evaluate(() => {
            const w = window as unknown as { __promptSeen: boolean; __handleSeen: boolean }
            return w.__promptSeen && w.__handleSeen
          })
        )
        .toBe(true)
      const handlesBefore = await page.evaluate(
        () => (window as unknown as { __handleRenders: number }).__handleRenders
      )
      const rendersBefore = await page.evaluate(
        () => (window as unknown as { __promptRenders: number }).__promptRenders
      )
      const before = await page.evaluate(() => (window as unknown as { __promptChanges: number }).__promptChanges)
      await page.getByRole("switch", { name: "Send Auxiliary Prompt", exact: true }).click()
      await expectSaveState(page, UNSAVED)
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
      expect(
        (await page.evaluate(() => (window as unknown as { __promptChanges: number }).__promptChanges)) - before
      ).toBe(0)
      expect(
        (await page.evaluate(() => (window as unknown as { __promptRenders: number }).__promptRenders)) - rendersBefore
      ).toBe(0)
      expect(
        (await page.evaluate(() => (window as unknown as { __handleRenders: number }).__handleRenders)) - handlesBefore
      ).toBe(0)
    })
