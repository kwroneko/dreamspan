// Text boxes resize from their bottom-right corner (editorresize1, 2026-11-23): the code editor's
// grip and a textarea's own corner set the box's height past its max height, a double-click there
// returns to fitting the text, and only what is under the box moves. Synthetic fixtures only.
import { readFileSync } from "node:fs"
import type { LibraryRef } from "@dreamspan/shared/library.ts"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { filesOf } from "./support/files.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const longText = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of the harbour log.`).join("\n")
const CAP = 512 // min(60vh, 32rem) at a 1400 px tall window

const upload = async (page: Page, name: string, doc: unknown) => {
  const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    headers: { origin: server().url, "content-type": "application/octet-stream" },
    data: Buffer.from(JSON.stringify(doc))
  })
  expect(response.status()).toBe(200)
  return ((await response.json()) as { library: { ref: LibraryRef } }).library.ref
}

const height = async (locator: Locator) => (await locator.boundingBox())!.height
const frameOf = (page: Page, grip: Locator) => page.locator("[data-field-frame]", { has: grip }).last()

/** Drags from the middle of `grip` by `dy` pixels with the mouse. */
const drag = async (page: Page, grip: Locator, dy: number) => {
  await grip.scrollIntoViewIfNeeded()
  const box = (await grip.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let step = 1; step <= 5; step++) await page.mouse.move(x, y + (dy * step) / 5)
  await page.mouse.up()
}

const login = async (page: Page) => {
  await page.setViewportSize({ width: 1280, height: 1400 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
}

test("the code editor's grip sets the box's height past its cap; a double-click returns to fitting", async ({
  page
}, testInfo) => {
  await login(page)
  const card = await upload(page, "Grip card", {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: { name: "Grip card", description: longText, scenario: "Night watch.", first_mes: "The bell rings." }
  })
  await page.goto(`${server().url}/library/${card.id}`)
  const editor = page.getByRole("region", { name: "Card editor", exact: true })
  const description = editor.getByRole("textbox", { name: "Description", exact: true })
  await expect(description).toContainText("Line 1 of the harbour log.")
  const grip = page.locator('[aria-label="Resize Description"]')
  await expect(grip).toBeVisible()
  const frame = frameOf(page, grip)
  const scroller = frame.locator(".cm-scroller")
  await expect.poll(() => height(scroller)).toBe(CAP)

  // The grip is in the strip under the text: it covers neither the text nor its scrollbar.
  const gripBox = (await grip.boundingBox())!
  const scrollerBox = (await scroller.boundingBox())!
  const frameBox = (await frame.boundingBox())!
  expect(gripBox.y).toBeGreaterThanOrEqual(scrollerBox.y + scrollerBox.height)
  expect(gripBox.x + gripBox.width).toBeLessThanOrEqual(frameBox.x + frameBox.width)
  expect(gripBox.y + gripBox.height).toBeLessThanOrEqual(frameBox.y + frameBox.height)
  expect(frameBox.x + frameBox.width - (gripBox.x + gripBox.width)).toBeLessThan(8)
  expect(frameBox.y + frameBox.height - (gripBox.y + gripBox.height)).toBeLessThan(8)

  await expectLayout(page, testInfo, "card-editor-grip")

  // Only what is under the box moves, and by as much as the box grew.
  const below = editor.getByRole("textbox", { name: "Scenario", exact: true })
  const top = frameBox.y
  const belowTop = (await below.boundingBox())!.y
  const frameHeight = await height(frame)
  await drag(page, grip, 300)
  await expect.poll(() => height(scroller)).toBeGreaterThan(CAP + 250)
  const grown = (await height(frame)) - frameHeight
  expect(Math.abs((await below.boundingBox())!.y - belowTop - grown)).toBeLessThan(2)
  expect((await frame.boundingBox())!.y).toBeCloseTo(top, 0)

  // The chosen height holds while the text changes.
  const chosen = await height(scroller)
  await description.click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("\nOne more line.")
  expect(await height(scroller)).toBe(chosen)

  // Smaller than the text fits, too: the text scrolls.
  await drag(page, grip, -(chosen - 150))
  await expect.poll(() => height(scroller)).toBeLessThan(200)

  // A double-click returns the box to growing with its text, up to the cap.
  await grip.dblclick()
  await expect.poll(() => height(scroller)).toBe(CAP)
})

test("a short code editor box keeps growing with its text until its grip is dragged", async ({ page }) => {
  await login(page)
  const card = await upload(page, "Short card", {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: { name: "Short card", description: "One line.", first_mes: "The bell rings." }
  })
  await page.goto(`${server().url}/library/${card.id}`)
  const editor = page.getByRole("region", { name: "Card editor", exact: true })
  const description = editor.getByRole("textbox", { name: "Description", exact: true })
  await expect(description).toContainText("One line.")
  const grip = page.locator('[aria-label="Resize Description"]')
  const scroller = frameOf(page, grip).locator(".cm-scroller")
  const start = await height(scroller)
  await description.click()
  await page.keyboard.press("ControlOrMeta+End")
  for (let i = 0; i < 12; i++) await page.keyboard.press("Enter")
  await expect.poll(() => height(scroller)).toBeGreaterThan(start + 50)
  await drag(page, grip, 80)
  const chosen = await height(scroller)
  await description.click()
  await page.keyboard.press("ControlOrMeta+End")
  for (let i = 0; i < 12; i++) await page.keyboard.press("Enter")
  await page.waitForTimeout(100)
  expect(await height(scroller)).toBe(chosen)
  await grip.dblclick()
  await expect.poll(() => height(scroller)).toBeGreaterThan(chosen)
})

test("the preset prompt editor has the grip, sets its height and passes the layout audit", async ({
  page
}, testInfo) => {
  await login(page)
  const preset = JSON.parse(
    readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
  ) as { prompts: Array<{ identifier: string; content?: string }> }
  preset.prompts.find((prompt) => prompt.identifier === "main")!.content = longText
  const ref = await upload(page, "Grip preset", preset)
  await page.goto(`${server().url}/library/${ref.id}`)
  const box = page.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })
  await expect(box).toContainText("Line 1 of the harbour log.")
  const grip = page.locator('[aria-label="Resize Prompt: Main Prompt"]')
  await expect(grip).toBeVisible()
  await expectLayout(page, testInfo, "preset-editor-grip")
  // A preset's prompt grows with its text without a cap; the grip still sets its height.
  const scroller = frameOf(page, grip).locator(".cm-scroller")
  const fitted = await height(scroller)
  expect(fitted).toBeGreaterThan(CAP)
  await drag(page, grip, -(fitted - 300))
  await expect.poll(() => height(scroller)).toBeLessThan(350)
  await grip.dblclick()
  await expect.poll(() => height(scroller)).toBe(fitted)
})

test("a textarea's corner resizes it past its max height; a double-click there undoes that", async ({ page }) => {
  await login(page)
  const book = await upload(page, "Grip book", {
    name: "Grip book",
    entries: { 0: { uid: 0, key: ["harbour", "quay", "lamp"], comment: "Harbour", content: "The quay.", order: 0 } }
  })
  await page.goto(`${server().url}/library/${book.id}`)
  const editor = page.getByRole("region", { name: "Lorebook editor", exact: true })
  await editor
    .getByRole("button", { name: /^Open / })
    .first()
    .click()
  const keys = editor.getByRole("textbox", { name: "Primary keys", exact: true })
  await keys.focus()
  await expect(keys).toBeVisible()
  expect(await keys.evaluate((box) => getComputedStyle(box).resize)).toBe("vertical")
  // A cap from a stylesheet, as a fitted box's class gives it.
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync('textarea[aria-label="Primary keys"] { max-height: 90px; }')
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  })
  const start = await height(keys)
  expect(start).toBeLessThanOrEqual(90)
  // A click in the corner that doesn't drag leaves the box fitting its text.
  const corner = async () => {
    const rect = (await keys.boundingBox())!
    return { x: rect.x + rect.width - 4, y: rect.y + rect.height - 4 }
  }
  let at = await corner()
  await page.mouse.click(at.x, at.y)
  expect(await keys.evaluate((box) => box.style.height)).toBe("")
  at = await corner()
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  for (let step = 1; step <= 5; step++) await page.mouse.move(at.x, at.y + step * 40)
  await page.mouse.up()
  await expect.poll(() => height(keys)).toBeGreaterThan(150)
  at = await corner()
  await page.mouse.dblclick(at.x, at.y)
  await expect.poll(() => height(keys)).toBeCloseTo(start, 0)
})

// A box with no strip (a text file's editor) has the grip over its corner, in its bottom padding:
// at rest it's as tall as it was before the grip, its text and scrollbar uncovered.
test("a box without a strip has its grip over the corner and keeps its height", async ({ page }, testInfo) => {
  await login(page)
  const files = filesOf(page.request, server().url)
  await files.put("/files/grip/short.txt", "One line.")
  await files.put("/files/grip/long.txt", longText)
  for (const name of ["short.txt", "long.txt"]) {
    await page.goto(`${server().url}/files?${new URLSearchParams({ path: "/files/grip", file: name })}`)
    const opened = page.locator(`[data-file-open="/files/grip/${name}"]`)
    await expect(opened.getByRole("textbox", { name: `Contents of ${name}` })).toContainText(
      name === "short.txt" ? "One line." : "Line 1 of the harbour log."
    )
    const grip = opened.locator(`[aria-label="Resize Contents of ${name}"]`)
    await expect(grip).toBeVisible()
    const frame = frameOf(page, grip)
    await expect(frame.locator("[data-field-chrome]")).toHaveCount(0)
    const host = frame.locator("> div").first()
    const scroller = frame.locator(".cm-scroller")

    // The grip covers neither the scroller (its text and scrollbar) nor anything outside the box.
    const gripBox = (await grip.boundingBox())!
    const scrollerBox = (await scroller.boundingBox())!
    const frameBox = (await frame.boundingBox())!
    expect(gripBox.y).toBeGreaterThanOrEqual(scrollerBox.y + scrollerBox.height - 0.5)
    expect(gripBox.y + gripBox.height).toBeLessThanOrEqual(frameBox.y + frameBox.height)
    expect(gripBox.x + gripBox.width).toBeLessThanOrEqual(frameBox.x + frameBox.width)
    if (name === "long.txt")
      expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)

    // As tall as with master's styling (no grip room) at rest.
    const withGrip = await height(frame)
    await host.evaluate((element) => element.style.setProperty("--editor-grip-room", "0px"))
    expect(await height(frame)).toBeCloseTo(withGrip, 1)
    await host.evaluate((element) => element.style.setProperty("--editor-grip-room", "8px"))
    expect(await height(frame)).toBeCloseTo(withGrip, 1)

    if (name === "long.txt") {
      await expectLayout(page, testInfo, "file-editor-corner-grip", { scope: "[data-file-open]" })
      await drag(page, grip, 200)
      await expect.poll(() => height(frame)).toBeGreaterThan(withGrip + 150)
      await grip.dblclick()
      await expect.poll(() => height(frame)).toBeCloseTo(withGrip, 1)
    }
  }
})
