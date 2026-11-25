// Synthetic portraits only. Sweep the real column's resize handle in both directions,
// including either side of each reflow, and measure both top and stacked viewer headers.
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, type Locator, test } from "@playwright/test"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { shapeCard } from "./support/shapes.ts"

const server = serverPerFile(withAdmin)
const names = ["Shannon", "Shannon with a deliberately long portrait name"]
let chat = ""
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const [index, name] of names.entries()) {
    const response = await page.request.post(`${server().url}/library/import?name=portrait-${index}.png`, {
      data: shapeCard({ name, width: 1024, height: 1536 }, index * 120),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    expect(response.ok()).toBeTruthy()
  }
  const cards = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListLibrary({ kind: "card" }))
  const started = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.StartChat({
      cards: cards.map((card) => card.entityId),
      persona: null,
      greeting: 0,
      first: { _tag: "Send", content: "A synthetic portrait layout test.", speakerEntityId: null }
    })
  )
  chat = started.chat.id
  await page.close()
})

const audit = (headers: Locator) =>
  headers.evaluateAll((nodes) =>
    nodes.map((header) => {
      const bounds = header.getBoundingClientRect()
      const errors: string[] = []
      const selector = 'h2,[data-toolbar-slider],[data-zoom-percent],[role="group"],button'
      const controls = [...header.querySelectorAll<HTMLElement>(selector)].filter(
        (node) => node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility !== "hidden"
      )
      for (const node of [
        header,
        ...header.querySelectorAll<HTMLElement>("[data-zoom-controls],[data-zoom-group]"),
        ...controls
      ]) {
        const box = node.getBoundingClientRect()
        if (
          box.left < bounds.left - 0.5 ||
          box.right > bounds.right + 0.5 ||
          box.top < bounds.top - 0.5 ||
          box.bottom > bounds.bottom + 0.5
        )
          errors.push(`outside header: ${node.outerHTML.slice(0, 160)}`)
        // The heading intentionally ellipsizes long names; every control must fit its box.
        if (node.tagName !== "H2" && node.scrollWidth > node.clientWidth + 1)
          errors.push(`overflow: ${node.outerHTML.slice(0, 160)}`)
      }
      const leaves = controls.filter((node) => node.getAttribute("role") !== "group")
      for (const [index, a] of leaves.entries()) {
        const x = a.getBoundingClientRect()
        for (const b of leaves.slice(index + 1)) {
          const y = b.getBoundingClientRect()
          if (
            Math.min(x.right, y.right) - Math.max(x.left, y.left) > 0.5 &&
            Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 0.5
          )
            errors.push(`overlap: ${a.outerHTML.slice(0, 100)} / ${b.outerHTML.slice(0, 100)}`)
        }
      }
      const slider = header.querySelector<HTMLElement>("[data-toolbar-slider]")!
      const track = slider.getBoundingClientRect()
      const thumb = slider.querySelector<HTMLElement>("[data-layout-overlay]")!
      const thumbBox = thumb.getBoundingClientRect()
      const group = header.querySelector<HTMLElement>("[data-zoom-group]")!.getBoundingClientRect()
      const percent = header.querySelector<HTMLElement>("[data-zoom-percent]")!.getBoundingClientRect()
      const presets = header
        .querySelector<HTMLElement>('[role="group"][aria-label="Zoom presets"]')!
        .getBoundingClientRect()
      if (track.width > 0) {
        if (getComputedStyle(thumb).visibility === "hidden" || thumbBox.width < 10)
          errors.push(`missing thumb: ${slider.outerHTML}`)
        if (thumbBox.left < track.left - 0.5 || thumbBox.right > track.right + 0.5)
          errors.push(`thumb outside track: ${slider.outerHTML}`)
        if (track.width < 79.5) errors.push(`unusable slider: ${track.width}`)
        if (Math.abs(percent.left - track.right - 4) > 0.5) errors.push("slider and percentage separated")
      } else if (Math.abs(group.width - percent.width) > 0.5) errors.push("hidden slider left a spacer")
      if (Math.abs(presets.left - group.right - 12) > 0.5) errors.push("zoom groups separated")
      if (Math.abs(presets.height - 32) > 0.5) errors.push(`preset height: ${presets.height}`)
      return { width: bounds.width, height: bounds.height, slider: track.width > 0, errors }
    })
  )

for (const theme of ["dark", "light"] as const)
  test(`image column header fits from minimum to wide, ${theme}`, async ({ page }, info) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 2000, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chat}?panel=cast`)
    await expect(page.locator("html")).toHaveCSS("color-scheme", theme)
    for (const name of names)
      await page
        .getByRole("tabpanel", { name: "Cast", exact: true })
        .getByRole("button", { name: `View ${name}'s portrait`, exact: true })
        .click()
    await page.getByRole("button", { name: "Hide panel", exact: true }).click()
    const column = page.locator("[data-portrait-column]")
    const headers = column.locator("[data-portrait-toolbar]")
    await expect(headers).toHaveCount(2)
    await expect(headers.locator("[data-zoom-controls]")).toHaveCount(2)
    const resize = page.getByRole("separator", { name: "Resize the portrait", exact: true })
    await resize.focus()
    await page.keyboard.press("Home")
    await expect(resize).toHaveAttribute("aria-valuenow", "200")
    const setWidth = async (width: number) => {
      const at = (await resize.boundingBox())!
      const current = Number(await resize.getAttribute("aria-valuenow"))
      await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2)
      await page.mouse.down()
      await page.mouse.move(at.x + at.width / 2 + width - current, at.y + at.height / 2)
      await page.mouse.up()
      await expect(resize).toHaveAttribute("aria-valuenow", String(width))
    }
    const widths = [
      ...new Set([...Array.from({ length: 61 }, (_, i) => 200 + i * 10), 287, 288, 289, 543, 544, 545])
    ].sort((a, b) => a - b)
    for (const width of [...widths, ...widths.toReversed()]) {
      await setWidth(width)
      const result = await audit(headers)
      for (const row of result) {
        expect(row.errors, `${theme}, width ${width}: ${JSON.stringify(row)}`).toEqual([])
        expect(row.slider).toBe(row.width >= 288)
      }
      // Top header remains aligned to the shell header through every reflow.
      expect(result[0]!.height).toBe(65)
    }
    // All zoom methods remain usable with the slider absent; preset changes do not move controls.
    const top = headers.first()
    const positions = () =>
      top.locator("button,[data-zoom-percent]").evaluateAll((nodes) =>
        nodes.map((node) => {
          const { x, y, width, height } = node.getBoundingClientRect()
          return { x, y, width, height }
        })
      )
    const before = await positions()
    await top.getByRole("button", { name: "100%", exact: true }).click()
    await expect(top.locator("[data-zoom-percent]")).toHaveText("100%")
    expect(await positions()).toEqual(before)
    await top.getByRole("button", { name: "Fit", exact: true }).click()
    const image = column.locator("[data-image-viewer]").first()
    await image.hover()
    await page.mouse.wheel(0, -300)
    await expect(image).toHaveAttribute("data-zoom", "scaled")
    await top.getByRole("button", { name: "Fit", exact: true }).click()
    await image.evaluate((node) => {
      const box = node.getBoundingClientRect()
      const send = (type: string, id: number, dx: number) =>
        node.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: id,
            pointerType: "touch",
            clientX: box.x + box.width / 2 + dx,
            clientY: box.y + box.height / 2
          })
        )
      send("pointerdown", 11, -20)
      send("pointerdown", 12, 20)
      send("pointermove", 11, -50)
      send("pointermove", 12, 50)
      send("pointerup", 11, -50)
      send("pointerup", 12, 50)
    })
    await expect(image).toHaveAttribute("data-zoom", "scaled")
    await top.getByRole("button", { name: "Fit", exact: true }).click()
    const shots = process.env.IMAGE_COLUMN_SHOTS ?? info.outputPath("screenshots")
    await mkdir(shots, { recursive: true })
    for (const width of [200, 300, 500, 800]) {
      await setWidth(width)
      await page.mouse.move(0, 0)
      await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toHaveCount(0)
      for (const row of await audit(headers)) expect(row.errors).toEqual([])
      await column.screenshot({ path: join(shots, `${theme}-${width}.png`), animations: "disabled" })
      await page.screenshot({ path: join(shots, `${theme}-${width}-page.png`), animations: "disabled" })
    }
  })
