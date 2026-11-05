// A text box's own controls sit in a strip inside its border (ui/FieldFrame.tsx; owner,
// 2026-11-02): focusing, typing in and leaving a box moves nothing outside it, the strip shows
// only while the pointer or focus is in the box, and its controls come after the box in the
// focus order. Every multi-line versioned field opens large from its strip, editing the same
// text. Picking states in a box's edit history swaps the text in place, with no flash.
import { expect, test, type Locator, type Page } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"
import { openEntry } from "./support/lorebook.ts"
import { cardFieldsTab } from "./support/cardEditor.ts"
import { textBoxValue } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

/** The frame (border, strip) of the box `box` is in. */
const frameOf = (box: Locator) => box.page().locator("[data-field-frame]").filter({ has: box })

/**
 * Where every element on the page that isn't inside `frame` is, and the size of the ones around
 * it: a text that only grows or shrinks itself (a count) moves nothing. Whatever scrolled since the
 * first measure is scrolled back first, so the page scrolling to the box counts as nothing moving.
 * The page's own save status ("Changed since revision 1", "Saving…") and the line holding it are
 * left out: they report the change, at the end of their row.
 */
const boxesOutside = (frame: Locator) =>
  frame.evaluate((frame) => {
    const skip = (element: Element) =>
      frame.contains(element) ||
      element.matches(':has(> [role="status"])') ||
      element.closest('[role="status"], [role="tooltip"], [data-base-ui-portal]') !== null
    const kept = window as unknown as {
      fieldIds?: WeakMap<Element, string>
      fieldNext?: number
      fieldScrolls?: ReadonlyArray<readonly [Element, number, number]>
    }
    const all = [document.documentElement, ...document.body.querySelectorAll("*")]
    if (kept.fieldScrolls)
      for (const [element, top, left] of kept.fieldScrolls) element.scrollTo({ top, left, behavior: "instant" })
    else kept.fieldScrolls = all.map((element) => [element, element.scrollTop, element.scrollLeft] as const)
    // Each element keeps the name it got on the first measure, so one added elsewhere shifts nothing.
    kept.fieldIds ??= new WeakMap()
    const out: Record<string, string> = {}
    for (const element of document.body.querySelectorAll("*")) {
      if (skip(element)) continue
      const r = element.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      let id = kept.fieldIds.get(element)
      if (id === undefined) {
        kept.fieldNext = (kept.fieldNext ?? 0) + 1
        const label = element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 24) ?? ""
        id = `${kept.fieldNext}:${element.tagName}:${label}`
        kept.fieldIds.set(element, id)
      }
      out[id] = `${r.x},${r.y}${element.contains(frame) ? `,${r.width},${r.height}` : ""}`
    }
    return out
  })

const moved = (before: Record<string, string>, after: Record<string, string>) =>
  Object.keys(before)
    .filter((key) => key in after && before[key] !== after[key])
    .map((key) => `${key} ${before[key]} -> ${after[key]}`)

const opacity = (element: Locator) => element.evaluate((e) => Number(getComputedStyle(e).opacity))

/** Focus, type, blur: nothing outside the box moves or changes size, the box included. */
const expectStill = async (page: Page, box: Locator, text: string) => {
  const frame = frameOf(box)
  await expect(frame).toHaveCount(1)
  await page.mouse.move(0, 0)
  // An entry that has just opened is still turning its chevron (a transform transition, which
  // moves its box by a fraction of a pixel as it ends): measure once every animation is over.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined))
    )
  )
  const size = async () => frame.evaluate((e) => [e.getBoundingClientRect().width, e.getBoundingClientRect().height])
  const outer = await size()
  await page.evaluate(() => delete (window as unknown as { fieldScrolls?: unknown }).fieldScrolls)
  const before = await boxesOutside(frame)
  await box.click()
  await page.keyboard.press("End")
  await page.keyboard.type(text)
  await expect(frame.getByText("edited", { exact: true })).toBeVisible()
  expect(moved(before, await boxesOutside(frame))).toEqual([])
  expect(await size()).toEqual(outer)
  // Leave the box (a click in the corner would land on the phone's tab strip, which shows once a
  // second tab is open).
  await box.evaluate((element) => {
    const active = element.ownerDocument.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  await page.mouse.move(0, 0)
  await expect(frame.locator("[data-field-edited]")).toBeVisible()
  expect(
    await frame.locator("[data-field-edited]").evaluate((e) => {
      let alpha = 1
      for (let node: Element | null = e; node; node = node.parentElement)
        alpha *= Number(getComputedStyle(node).opacity)
      return alpha
    })
  ).toBe(1)
  expect(moved(before, await boxesOutside(frame))).toEqual([])
  expect(await size()).toEqual(outer)
}

for (const width of [1440, 390])
  test(`at ${width} px, focusing, typing in and leaving a card's, a lorebook entry's and a one-line box moves nothing around it`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const card = await admin((api) => api.CreateCard({ label: `Still ${width}`, name: `Still ${width}` }))
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/library/${card.id}`)
    await expectStill(page, page.getByRole("textbox", { name: /^Description/ }), "A quiet harbour.")
    const description = frameOf(page.getByRole("textbox", { name: /^Description/ }))
    const beforeSave = await description.boundingBox()
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await expect(description.locator("[data-field-edited]")).toHaveCount(0)
    const afterSave = await description.boundingBox()
    expect(afterSave?.width).toBe(beforeSave?.width)
    expect(afterSave?.height).toBe(beforeSave?.height)
    await cardFieldsTab(page, "Metadata")
    await expectStill(page, page.getByRole("textbox", { name: "Creator", exact: true }), "Someone")

    const response = await page.request.post(`${server().url}/library/import?name=book${width}.json`, {
      headers: { "content-type": "application/octet-stream", origin: server().url },
      data: Buffer.from(
        JSON.stringify({
          name: `Book ${width}`,
          entries: { 0: { uid: 0, key: ["k"], comment: "Pier", content: "Old." } }
        })
      )
    })
    const book = (await response.json()).library.ref as { id: string }
    await page.goto(`${server().url}/library/${book.id}`)
    await openEntry(page, "Pier")
    await expectStill(page, page.getByRole("textbox", { name: "Entry content" }), " New.")
  })

test("the strip shows only with the pointer or focus in the box, and its controls follow the box in the focus order", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const card = await admin((api) => api.CreateCard({ label: "Keys", name: "Keys" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${card.id}`)
  const box = page.getByRole("textbox", { name: /^Description/ })
  const frame = frameOf(box)
  const strip = frame.locator("[data-field-chrome]")
  const controls = strip.locator("[data-field-reveal]").last()
  await page.mouse.move(0, 0)
  await expect.poll(() => opacity(controls)).toBe(0)
  await frame.hover({ position: { x: 20, y: 10 } })
  await expect.poll(() => opacity(controls)).toBeCloseTo(0.6)
  await strip.hover()
  await expect.poll(() => opacity(controls)).toBe(1)
  await page.mouse.move(0, 0)
  await expect.poll(() => opacity(controls)).toBe(0)

  // Typing gives it an edit history; Tab from the box reaches the strip's controls, which show.
  await box.click()
  await page.keyboard.type("Lanterns.")
  const history = frame.getByRole("button", { name: "Edit history of Description", exact: true })
  await expect(history).toBeVisible()
  await page.mouse.move(0, 0)
  await expect.poll(() => opacity(controls)).toBeCloseTo(0.6)
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press("Tab")
    if (await history.evaluate((e) => e === document.activeElement)) break
  }
  await expect(history).toBeFocused()
  // Every control on the way was in the strip.
  await expect.poll(() => opacity(controls)).toBe(1)
  await page.keyboard.press("Enter")
  await expect(page.getByRole("dialog", { name: "Edit history: Description" })).toBeVisible()
})

test("picking states in a box's edit history swaps the text in place: nothing is removed or blank", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const card = await admin((api) => api.CreateCard({ label: "Flash", name: "Flash" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${card.id}`)
  const box = page.getByRole("textbox", { name: /^Description/ })
  const texts = ["First state of the text.", "Second, longer state of the text, two sentences. Here.", "Third."]
  for (const text of texts) {
    await box.fill(text)
    await expect
      .poll(() => admin((api) => api.OpenEditor({ refId: card.id })).then((x) => x.drafts[0]?.content))
      .toBe(text)
  }
  await page.getByRole("button", { name: "Edit history of Description", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Edit history: Description" })
  const pane = dialog.getByLabel("Text of the state")
  await expect(pane).toHaveText(texts[1]!)
  // Every frame from here on: whether the text pane is there, and what was removed under the dialog.
  await dialog.evaluate((dialog) => {
    const seen = { removed: 0, blank: 0, frames: 0 }
    ;(window as unknown as { flash: typeof seen }).flash = seen
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.removedNodes)
          if (node instanceof Element && (node.matches("pre") || node.querySelector("pre"))) seen.removed += 1
    }).observe(dialog, { childList: true, subtree: true })
    const tick = () => {
      seen.frames += 1
      if (!dialog.querySelector('[aria-label="Text of the state"]')) seen.blank += 1
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const items = dialog.getByRole("list", { name: "Earlier states" }).getByRole("button")
  const count = await items.count()
  expect(count).toBeGreaterThanOrEqual(3)
  for (const index of [0, 2, 1, 0, 2]) {
    await items.nth(index).click()
    await expect(items.nth(index)).toHaveAttribute("aria-pressed", "true")
    await expect(pane).not.toHaveAttribute("aria-busy", "true")
  }
  await expect(pane).toHaveText(texts[0]!)
  const seen = await page.evaluate(
    () => (window as unknown as { flash: { removed: number; blank: number; frames: number } }).flash
  )
  expect(seen.frames).toBeGreaterThan(0)
  expect(seen).toMatchObject({ removed: 0, blank: 0 })
})

/**
 * Opens the box large from its strip, types there, closes it: the box in place has the same text
 * and has focus again.
 */
const expectOpensLarge = async (page: Page, box: Locator, name: string, label = name) => {
  const frame = frameOf(box)
  await frame.getByRole("button", { name: `Open ${label} large`, exact: true }).click()
  const dialog = page.getByRole("dialog", { name: label, exact: true })
  const large = dialog.getByRole("textbox", { name, exact: true })
  await expect(large).toBeVisible()
  await page.keyboard.press("Control+End")
  await page.keyboard.type(" Written large.")
  const close = dialog.getByRole("button", { name: "Close", exact: true })
  await expect(close).toHaveCount(1)
  const target = (await close.boundingBox())!
  expect(target.width).toBeGreaterThanOrEqual(32)
  expect(target.height).toBeGreaterThanOrEqual(32)
  await close.hover()
  await expect(page.getByText("Close", { exact: true })).toBeVisible()
  await close.click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => textBoxValue(box)).toMatch(/ Written large\.$/)
  await expect
    .poll(() => box.evaluate((e) => (e.getRootNode() as Document | ShadowRoot).activeElement === e))
    .toBe(true)
}

test("every multi-line versioned field opens large from its strip, editing the same text: a card's, a note's, a preset prompt's, a lorebook entry's", async ({
  page
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const card = await admin((api) => api.CreateCard({ label: "Large", name: "Large" }))
  await page.goto(`${server().url}/library/${card.id}`)
  const description = page.getByRole("textbox", { name: /^Description/ })
  await description.fill("A harbour.")
  await expectOpensLarge(page, description, (await description.getAttribute("aria-label"))!, "Description")

  await cardFieldsTab(page, "Notes")
  await page.getByRole("button", { name: "Add note", exact: true }).first().click()
  const anyNote = page.getByRole("textbox", { name: /^Text of / }).first()
  await expect(anyNote).toBeVisible()
  const noteName = (await anyNote.getAttribute("aria-label"))!
  const note = page.getByRole("textbox", { name: noteName, exact: true })
  await note.fill("Remember the storm.")
  await expectOpensLarge(page, note, noteName)

  const preset = await admin((api) => api.CreatePreset({ label: "Large preset" }))
  await page.goto(`${server().url}/library/${preset.id}`)
  const anyPrompt = page.getByRole("textbox", { name: /^Prompt: / }).first()
  await expect(anyPrompt).toBeVisible()
  const promptName = (await anyPrompt.getAttribute("aria-label"))!
  await expectOpensLarge(page, page.getByRole("textbox", { name: promptName, exact: true }), promptName)

  const response = await page.request.post(`${server().url}/library/import?name=large.json`, {
    headers: { "content-type": "application/octet-stream", origin: server().url },
    data: Buffer.from(
      JSON.stringify({ name: "Large book", entries: { 0: { uid: 0, key: ["k"], comment: "Pier", content: "Old." } } })
    )
  })
  const book = (await response.json()).library.ref as { id: string }
  await page.goto(`${server().url}/library/${book.id}`)
  await openEntry(page, "Pier")
  await expectOpensLarge(page, page.getByRole("textbox", { name: "Entry content" }), "Entry content")
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`edited clears on returning to the saved text at ${width}px in ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      const card = await admin((api) =>
        api.CreateCard({ label: `Reverted ${width} ${theme}`, name: "Synthetic reverted field" })
      )
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/library/${card.id}`)
      await page.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), theme)
      const box = page.getByRole("textbox", { name: /^Description/ })
      const frame = frameOf(box)
      const size = await frame.boundingBox()
      await box.fill("Temporary edit")
      await expect(frame.locator("[data-field-edited]")).toBeVisible()
      await box.fill("")
      await expect(frame.locator("[data-field-edited]")).toHaveCount(0)
      await page.locator("body").click({ position: { x: 1, y: 1 } })
      await expect
        .poll(() =>
          admin((api) => api.OpenEditor({ refId: card.id })).then(
            (snapshot) => snapshot.drafts.find((draft) => draft.key.field === '["description"]')?.content
          )
        )
        .toBe("")
      expect((await frame.boundingBox())?.height).toBe(size?.height)
      await page.screenshot({ path: info.outputPath("reverted.png") })
      await page.reload()
      await expect.poll(() => textBoxValue(box)).toBe("")
      await expect(frame.locator("[data-field-edited]")).toHaveCount(0)
    })
