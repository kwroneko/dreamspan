import { expect, type Page, test } from "@playwright/test"
import { portraitPng } from "./support/portrait.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "80", FAKE_GENERATOR_TOKENS: "80" })
test.setTimeout(120_000)

let ready: Promise<void> | null = null
const prepare = async (page: Page) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await (ready ??= (async () => {
    for (const name of ["Mira", "Bo"]) {
      const response = await page.request.post(`${server().url}/library/import?name=${name}.json`, {
        data: Buffer.from(
          JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name, first_mes: `${name} waves.` } })
        ),
        headers: { origin: server().url, "content-type": "application/octet-stream" }
      })
      expect(response.ok()).toBeTruthy()
      await page.goto(`${server().url}/library`)
      await page.getByRole("link", { name: `Edit ${name}`, exact: true }).click()
      await page
        .getByLabel("Choose an avatar, or drop it here")
        .setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: portraitPng() })
      await expect(page.getByRole("img", { name: "The card's avatar" })).toBeVisible()
    }
    await page.goto(`${server().url}/library`)
    await page.getByRole("checkbox", { name: "Bo: Persona" }).click()
    await expect(page.getByRole("checkbox", { name: "Bo: Persona" })).toBeChecked()
  })())
}
const chat = async (page: Page) => {
  await prepare(page)
  await page.goto(`${server().url}/library`)
  await page.getByRole("link", { name: "Start a chat with Mira" }).click()
  await page.getByLabel("Playing as").click()
  await page.getByRole("option", { name: "Bo", exact: true }).click()
  await page.getByLabel("Message", { exact: true }).fill("Hello there.")
  await page.getByRole("button", { name: "Send as Bo" }).click()
  await expect(page).toHaveURL(/\/chats\//)
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0)
  await expect(page.locator("article[data-slot]")).toHaveCount(3)
}
const select = async (page: Page, field: string, option: string) => {
  await page.getByRole("button", { name: "Image settings", exact: true }).first().click()
  const popover = page.getByRole("dialog", { name: "Images in this browser" })
  await popover.getByLabel(field).click()
  await page.getByRole("option", { name: option, exact: true }).click()
  await page.keyboard.press("Escape")
}

for (const width of [1440, 390]) {
  test(`whole portraits from messages, personas, Cast and header at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await chat(page)
    if (width === 390) {
      await expect(
        page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "Characters", exact: true })
      ).toBeVisible()
      await expect(
        page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "Chats", exact: true })
      ).toBeVisible()
    }
    const portrait = page.locator("article[data-slot] .chat-portrait").first()
    await expect(portrait).toHaveCSS("width", "60px")
    await expect(portrait).toHaveCSS("height", "90px")
    await expect(portrait).toHaveCSS("border-radius", "10px")
    await portrait.click()
    const panel = width === 390 ? page.getByRole("dialog") : page.getByRole("complementary", { name: "Chat panel" })
    const image = panel.getByRole("img", { name: "Mira's full portrait" })
    await expect(image).toHaveCSS("object-fit", "contain")
    await expect.poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeLessThanOrEqual(768)
    await expect(image).toHaveAttribute("src", /&w=(384|768)$/)
    await expect.poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalHeight)).toBeGreaterThan(0)
    await page.reload()
    await expect(image).toBeVisible()
    await panel.getByRole("button", { name: "Open full size", exact: true }).click()
    const full = page.getByRole("dialog", { name: "Mira — full size" })
    await expect(full.getByRole("img")).toHaveCSS("width", "900px")
    await expect(full.getByRole("img")).toHaveAttribute("src", /^\/library\/media\?id=[^&]+$/)
    expect((await full.getByRole("img").boundingBox())!.x).toBeGreaterThanOrEqual(0)
    await page.keyboard.press("Escape")
    if (width === 390) await page.getByRole("button", { name: "Close", exact: true }).click()
    else await page.getByRole("button", { name: "Close the panel" }).click()
    await page.locator("article[data-slot]").getByRole("button", { name: "View Bo's portrait" }).click()
    await expect(page.getByRole("img", { name: "Bo's full portrait" })).toBeVisible()
    if (width === 390) await page.getByRole("button", { name: "Close", exact: true }).click()
    else await page.getByRole("button", { name: "Close the panel" }).click()
    await page.locator("header").getByRole("button", { name: "View Mira's portrait", exact: true }).first().click()
    await expect(page.getByRole("img", { name: "Mira's full portrait" })).toBeVisible()
    await page.getByRole("tab", { name: "Cast", exact: true }).click()
    await page
      .getByRole("list", { name: "Characters in this chat" })
      .getByRole("button", { name: "View Bo's portrait" })
      .click()
    await expect(page.getByRole("img", { name: "Bo's full portrait" })).toBeVisible()
    if (width === 390) await page.getByRole("button", { name: "Close", exact: true }).click()
    else await page.getByRole("button", { name: "Close the panel" }).click()
    for (const [label, radius] of [
      ["Circle (50 × 50)", "9999px"],
      ["Square (50 × 50)", "2px"],
      ["Rounded square (50 × 50)", "10px"]
    ]) {
      await select(page, "Chat portraits", label!)
      await expect(portrait).toHaveCSS("width", "50px")
      await expect(portrait).toHaveCSS("height", "50px")
      await expect(portrait).toHaveCSS("border-radius", radius!)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  })
}

test("every image follows concealment, reload's first frame and another tab", async ({ page, context }) => {
  await prepare(page)
  await page.goto(`${server().url}/`)
  await page.getByRole("button", { name: "Blur all images", exact: true }).click()
  await expect(page.locator("img").first()).toHaveCSS("filter", "blur(14px) saturate(0.6)")
  await page.locator("img").first().hover()
  await expect(page.locator("img").first()).toHaveCSS("filter", "blur(14px) saturate(0.6)")
  await page.addInitScript(() => {
    const state = window as typeof window & { exposedFrames: number; imageFrames: number }
    state.exposedFrames = 0
    state.imageFrames = 0
    const frame = () => {
      for (const img of document.images) {
        state.imageFrames++
        if (!getComputedStyle(img).filter.includes("blur")) state.exposedFrames++
      }
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
  await page.reload()
  await expect(page.locator("img").first()).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => (window as typeof window & { imageFrames: number }).imageFrames))
    .toBeGreaterThan(0)
  expect(await page.evaluate(() => (window as typeof window & { exposedFrames: number }).exposedFrames)).toBe(0)
  const other = await context.newPage()
  await other.goto(`${server().url}/`)
  await expect(other.locator("img").first()).toHaveCSS("filter", "blur(14px) saturate(0.6)")
  await select(other, "Every image", "Hide")
  await expect(page.locator("img").first()).toHaveCSS("visibility", "hidden")
  await expect(page.locator("[data-image-fallback]").first()).toBeVisible()
  await page.keyboard.press("Alt+Shift+B")
  await expect(other.locator("img").first()).toHaveCSS("visibility", "visible")
  await page.keyboard.press("Alt+Shift+B")
  await expect(page.locator("img").first()).toHaveCSS("visibility", "hidden")
  await other.close()
  await chat(page)
  await expect(page.locator("article img").first()).toHaveCSS("visibility", "hidden")
  await page.locator("article .chat-portrait").first().click()
  await expect(page.getByRole("img", { name: "Mira's full portrait", includeHidden: true })).toHaveCSS(
    "visibility",
    "hidden"
  )
  await expect(page.getByRole("button", { name: "Open full size", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Close the panel" }).click()
  await page.getByLabel("Message", { exact: true }).focus()
  await page.keyboard.press("Alt+Shift+B")
  await expect(page.locator("article img").first()).toHaveCSS("visibility", "visible")
  // New surfaces inherit concealment even without a feature-specific preference hook.
  await select(page, "Every image", "Blur")
  await page.evaluate(() => {
    const img = document.createElement("img")
    img.id = "future-image"
    img.style.filter = "none"
    document.body.append(img)
    const canvas = document.createElement("canvas")
    canvas.id = "future-canvas"
    document.body.append(canvas)
  })
  await expect(page.locator("#future-image")).toHaveCSS("filter", "blur(14px) saturate(0.6)")
  await expect(page.locator("#future-canvas")).toHaveCSS("filter", "blur(14px) saturate(0.6)")
  await page.goto(`${server().url}/library`)
  await page.getByRole("link", { name: "Edit Mira", exact: true }).click()
  await expect(page.getByRole("img", { name: "The card's avatar" })).toHaveCSS("filter", "blur(14px) saturate(0.6)")
})

test("both sidebars resize by pointer and keyboard, keep widths per user, and reset", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await chat(page)
  await page.locator("article .chat-portrait").first().click()
  for (const [name, delta] of [
    ["Resize sidebar", 60],
    ["Resize chat panel", -100]
  ] as const) {
    const handle = page.getByRole("separator", { name })
    const before = Number(await handle.getAttribute("aria-valuenow"))
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + 4, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(box.x + 4 + delta, box.y + 200, { steps: 8 })
    await page.mouse.up()
    await expect(handle).toHaveAttribute("aria-valuenow", String(before + Math.abs(delta)))
    await handle.focus()
    await page.keyboard.press(name === "Resize sidebar" ? "ArrowLeft" : "ArrowRight")
    await expect(handle).toHaveAttribute("aria-valuenow", String(before + Math.abs(delta) - 10))
  }
  const values = await page
    .getByRole("separator")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-valuenow")))
  await page.reload()
  await expect(page.getByRole("tab", { name: "Portrait" })).toHaveAttribute("aria-selected", "true")
  expect(
    await page.getByRole("separator").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-valuenow")))
  ).toEqual(values)
  await page.setViewportSize({ width: 1024, height: 900 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await expect
    .poll(async () =>
      Number(await page.getByRole("separator", { name: "Resize chat panel" }).getAttribute("aria-valuemax"))
    )
    .toBeLessThan(400)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole("separator").filter({ visible: true })).toHaveCount(0)
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  for (const [name, value] of [
    ["Resize sidebar", "320"],
    ["Resize chat panel", "416"]
  ] as const) {
    const handle = page.getByRole("separator", { name })
    await handle.dblclick({ position: { x: 4, y: 200 } })
    await expect(handle).toHaveAttribute("aria-valuenow", value!)
  }
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("rp.panelWidth.")).length)
  ).toBe(2)
})
