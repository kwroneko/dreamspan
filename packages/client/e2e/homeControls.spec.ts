import { mkdir } from "node:fs/promises"
import { expect, type Locator, test } from "@playwright/test"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
test.beforeAll(async () => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.CreateCard({ label: "Mira", name: "Mira" }))
})

async function positions(controls: Locator) {
  return controls.evaluate((node) => {
    const box = (selector: string) => {
      const rect = node.querySelector(selector)!.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, right: rect.right }
    }
    return {
      root: node.getBoundingClientRect().width,
      filters: box(".card-grid-filter"),
      sort: box(".card-grid-sort"),
      search: box(".card-grid-search")
    }
  })
}

for (const surface of ["home", "sidebar"] as const) {
  test(`${surface}: measured container widths select all three control layouts`, async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(server().url)
    const sidebar = page.getByRole("complementary", { name: "Sidebar", exact: true })
    if (surface === "sidebar") {
      await sidebar
        .getByRole("group", { name: "Left panel", exact: true })
        .getByRole("button", { name: "Characters", exact: true })
        .click()
    }
    const controls = (surface === "home" ? page.getByRole("main") : sidebar).locator("[data-card-grid-controls]")
    await expect(controls.getByRole("group", { name: "Show", exact: true })).toBeVisible()
    const widths = await controls.evaluate((node) => {
      const width = (selector: string) => node.querySelector(selector)!.getBoundingClientRect().width
      return {
        filters: width(".card-grid-filter > *"),
        sort: width(".card-grid-sort > *"),
        search: width(".card-grid-search-size")
      }
    })
    const medium = Math.ceil(widths.sort + widths.search + 8)
    const wide = Math.ceil(widths.filters + widths.sort + 8)
    expect(wide).toBeGreaterThan(medium)
    for (const [layout, width] of [
      ["wide", wide + 30],
      ["medium", medium + 10],
      ["narrow", 358]
    ] as const) {
      // Keep the viewport fixed: the controls must respond to their own container.
      if (surface === "sidebar") {
        const grip = page.getByRole("separator", { name: "Resize sidebar", exact: true })
        const box = (await grip.boundingBox())!
        const currentWidth = (await controls.boundingBox())!.width
        await page.mouse.move(box.x + box.width / 2, box.y + 100)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width / 2 + width - currentWidth, box.y + 100, { steps: 10 })
        await page.mouse.up()
      } else {
        await controls.evaluate((node, width) => {
          ;(node as HTMLElement).style.width = `${width}px`
        }, width)
      }
      await expect
        .poll(async () => {
          const { filters, sort, search } = await positions(controls)
          if (Math.abs(filters.y - sort.y) < 1 && search.y > sort.y) return "wide"
          if (sort.y > filters.y && Math.abs(search.y - sort.y) < 1) return "medium"
          if (sort.y > filters.y && search.y > sort.y) return "narrow"
          return "unknown"
        })
        .toBe(layout)
      const boxes = await positions(controls)
      expect(Math.abs(boxes.sort.right - (boxes.filters.x + boxes.root))).toBeLessThan(1)
      expect(boxes.search.x).toBe(boxes.filters.x)
      if (layout === "narrow") {
        expect(boxes.search.width).toBe(boxes.root)
        expect(
          await controls.locator(".card-grid-filter").evaluate((node) => node.scrollWidth > node.clientWidth)
        ).toBe(true)
        const buttons = await controls
          .getByRole("group", { name: "Show", exact: true })
          .getByRole("button")
          .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().y))
        expect(new Set(buttons).size).toBe(1)
        await controls.getByRole("button", { name: "Groups", exact: true }).click()
        await expect(controls.getByRole("button", { name: "Groups", exact: true })).toHaveAttribute(
          "aria-pressed",
          "true"
        )
        await controls.getByRole("button", { name: "All", exact: true }).click()
      }
      if (layout === "wide") {
        const count = controls.getByRole("group", { name: "Show", exact: true }).locator("button span").first()
        const original = await count.textContent()
        await count.evaluate((node) => {
          node.textContent = "10,000,000,000"
        })
        await expect
          .poll(async () => {
            const boxes = await positions(controls)
            return boxes.sort.y > boxes.filters.y && Math.abs(boxes.sort.y - boxes.search.y) < 1
          })
          .toBe(true)
        await count.evaluate((node, text) => {
          node.textContent = text
        }, original)
        await expect
          .poll(async () => {
            const boxes = await positions(controls)
            return Math.abs(boxes.filters.y - boxes.sort.y) < 1
          })
          .toBe(true)
      }
      if (process.env.SCREENSHOT_DIR) {
        await mkdir(process.env.SCREENSHOT_DIR, { recursive: true })
        await controls.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${surface}-${layout}.png` })
      }
    }
  })
}
