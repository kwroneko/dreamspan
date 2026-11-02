import { expect, type Page, test } from "@playwright/test"
import { openPanel } from "./support/panel.ts"
import { hideAppNavigation, showAppNavigation } from "./support/appMenu.ts"
import { closePortrait, portraitView, portraitPng } from "./support/portrait.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { markPersona } from "./support/library.ts"
import { cardFieldsTab } from "./support/cardEditor.ts"

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
      await cardFieldsTab(page, "Metadata")
      await page
        .getByLabel("Choose an avatar, or drop it here")
        .setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: portraitPng() })
      // A new picture goes through the cutout chooser (§14.5c); its default cutout is saved.
      await page
        .getByRole("dialog", { name: /new picture$/ })
        .getByRole("button", { name: "Save picture" })
        .click()
      await expect(page.getByRole("img", { name: "The card's avatar" })).toBeVisible()
    }
    await page.goto(`${server().url}/library`)
    await markPersona(page, "Bo")
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
  // In a phone's chat the image settings are in the menu its header's ← opens.
  await showAppNavigation(page)
  await page.getByRole("button", { name: "Image settings", exact: true }).filter({ visible: true }).first().click()
  const popover = page.getByRole("dialog", { name: "Images" })
  await popover.getByLabel(field).click()
  await page.getByRole("option", { name: option, exact: true }).click()
  await page.keyboard.press("Escape")
  await hideAppNavigation(page)
}

for (const width of [1440, 390]) {
  test(`whole portraits from messages, personas, Cast and header at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await chat(page)
    if (width === 390) {
      // A phone's chat header takes the app bar's place (fheader): its ← opens the menu, the
      // chats first, then Characters and the rest.
      await showAppNavigation(page)
      await expect(
        page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Characters", exact: true })
      ).toBeVisible()
      await expect(
        page.getByRole("group", { name: "Left panel" }).getByRole("button", { name: "Chats", exact: true })
      ).toBeVisible()
      await hideAppNavigation(page)
    }
    const portrait = page.locator("article[data-slot] .chat-portrait").first()
    await expect(portrait).toHaveCSS("width", "60px")
    await expect(portrait).toHaveCSS("height", "90px")
    await expect(portrait).toHaveCSS("border-radius", "10px")
    // Any portrait opens the whole image: beside the chat on a wide screen, full-screen on a phone.
    await portrait.click()
    const lightbox = portraitView(page, "Mira")
    const image = lightbox.getByRole("img", { name: "Mira's full portrait" })
    await expect(image).toHaveAttribute("src", /^\/library\/media\?id=[^&]+$/)
    await expect.poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalHeight)).toBeGreaterThan(0)
    const fitted = (await image.boundingBox())!
    expect(fitted.x).toBeGreaterThanOrEqual(0)
    expect(fitted.x + fitted.width).toBeLessThanOrEqual(width)
    await lightbox.getByRole("button", { name: "100%", exact: true }).click()
    await expect(image).toHaveCSS("width", "900px")
    // Larger than its box at 100%: it scrolls, centred where the fitted view was.
    expect(await lightbox.locator("[data-image-viewer]").evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(
      true
    )
    await closePortrait(page)
    await expect(lightbox).toHaveCount(0)
    await page.locator("article[data-slot]").getByRole("button", { name: "View Bo's portrait" }).click()
    await expect(page.getByRole("img", { name: "Bo's full portrait" })).toBeVisible()
    await closePortrait(page)
    // The header's faces open a character's tab; a phone's header leaves them out for the name,
    // so there it's the panel's cast strip (fheader).
    if (width === 390) await openPanel(page, "Mira")
    else await page.locator("header").getByRole("button", { name: "Show Mira's card", exact: true }).first().click()
    // In a chat, the card's tab has the Cast row's actions, the full editor among them (f55e4e7).
    const card = page.getByRole("tabpanel", { name: "Mira", exact: true })
    await expect(card.getByRole("button", { name: "Open Mira in the full editor", exact: true })).toBeVisible()
    await card.getByRole("button", { name: "View full image", exact: true }).click()
    await expect(page.getByRole("img", { name: "Mira's full portrait" })).toBeVisible()
    await closePortrait(page)
    // The portrait closes alone: the panel (a sheet on a phone) stays where it was.
    await expect(card).toBeVisible()
    await page.getByRole("tab", { name: "Cast", exact: true }).click()
    // Mira among the characters, Bo, the persona, under "Your persona" above them (ftabs).
    for (const name of ["Mira", "Bo"]) {
      await page
        .getByRole("tabpanel", { name: "Cast", exact: true })
        .getByRole("button", { name: `View ${name}'s portrait`, exact: true })
        .click()
      await expect(page.getByRole("img", { name: `${name}'s full portrait` })).toBeVisible()
      await portraitView(page, name)
        .getByRole("button", { name: /^Close( the portrait)?$/ })
        .click()
      await expect(page.getByRole("img", { name: `${name}'s full portrait` })).toHaveCount(0)
    }
    if (width === 390) await page.getByRole("button", { name: "Close", exact: true }).click()
    else await page.getByRole("button", { name: "Close the panel" }).click()
    for (const [label, pixels] of [
      ["Smallest (48 × 72)", 48],
      ["Medium (72 × 108)", 72],
      ["Large (84 × 126)", 84],
      ["Small (60 × 90)", 60]
    ] as const) {
      await select(page, "Message portrait size", label)
      await expect(portrait).toHaveCSS("width", `${pixels}px`)
      await expect(portrait).toHaveCSS("height", `${pixels * 1.5}px`)
      await expect(portrait).toHaveCSS("border-radius", "10px")
    }
    // Measure the rendered shape, including header, recent speakers and reply-from (those shown:
    // a phone's header leaves the faces out).
    const ratios = await page.locator("main [data-portrait]").evaluateAll((nodes) =>
      nodes.flatMap((node) => {
        const box = node.getBoundingClientRect()
        return box.height > 0 ? [box.width / box.height] : []
      })
    )
    expect(ratios.length).toBeGreaterThan(3)
    for (const ratio of ratios) expect(ratio).toBeCloseTo(2 / 3, 2)
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
  await expect(page.getByRole("button", { name: "100%", exact: true })).toHaveCount(0)
  await closePortrait(page)
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
  await cardFieldsTab(page, "Metadata")
  await expect(page.getByRole("img", { name: "The card's avatar" })).toHaveCSS("filter", "blur(14px) saturate(0.6)")
})

test("both sidebars resize by pointer and keyboard, keep widths per user, and reset", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await chat(page)
  await openPanel(page, "This chat")
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
  await expect(page.getByRole("tab", { name: "This chat" })).toHaveAttribute("aria-selected", "true")
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
  // A reset forgets the choice: the default shows, and a later default would too.
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("rp.panelWidth.")).length)
  ).toBe(0)
})
