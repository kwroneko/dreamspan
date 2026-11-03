// The preset editor's overlay (spec/PHASE1-DECISIONS.md §7, item 36): the Find list follows the
// text, the sticky toolbar has nothing showing above it, and the document names each place a note
// goes once, with its dividers. A made-up card with a note in each place, and made-up presets.
import { mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { NOTHING_TO_SAVE, UNSAVED, expectSaveState, saveButton } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "40" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = resolve(process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-preset-overlay-screenshots"))
mkdirSync(shots, { recursive: true })

const base = JSON.parse(
  readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
) as Record<string, unknown> & { prompt_order: Array<{ order: Array<{ identifier: string }> }> }

const upload = async (page: Page, name: string, data: unknown) => {
  const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    data: Buffer.from(JSON.stringify(data)),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
}

const note = (id: string, title: string, placement: Record<string, unknown>) => ({
  id,
  title,
  content: `${title} text.`,
  placement,
  on_by_default: true
})

/** A chat with Mira, whose notes sit at two depths and at the tail's start. */
const setUp = async (page: Page, preset: string, historyLast: boolean) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await upload(page, `Mira ${preset}`, {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: `Mira ${preset}`,
      description: "A harbor pilot.",
      first_mes: "The bell rings.",
      extensions: {
        rp_harness: {
          notes: [
            note("n-depth", "Tide table", { mode: "depth", depth: 2, role: "system" }),
            note("n-top", "Pilot's log", { mode: "depth", depth: 4, role: "system" }),
            note("n-bottom", "Harbor rules", { mode: "depth", depth: 4, role: "user" }),
            note("n-tail", "Tail rule", { mode: "section", section: "tail_start" })
          ]
        }
      }
    }
  })
  const order = historyLast
    ? base.prompt_order.map((o) => ({ ...o, order: o.order.filter((e) => e.identifier !== "jailbreak") }))
    : base.prompt_order
  await upload(page, preset, { ...base, prompt_order: order })
  return admin((api) =>
    Effect.gen(function* () {
      const ref = (yield* api.ListLibrary({ kind: "preset" })).find((r) => r.label === preset)!
      yield* api.ChangeGenerationDefaults({ change: { preset: ref.id } })
      const card = (yield* api.ListCards()).find((c) => c.name === `Mira ${preset}`)!
      const chat = yield* api.CreateChat({ title: preset })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: null,
        change: { _tag: "Join", entityId: card.entityId }
      })
      return chat.id
    })
  )
}

const open = async (page: Page, chatId: string) => {
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
  const panel = await openPanel(page, "Prompt preset")
  await panel.getByRole("button", { name: "Open the preset in the large editor", exact: true }).click()
  const overlay = page.getByRole("dialog", { name: "Preset editor", exact: true })
  await expect(overlay).toBeVisible()
  return overlay
}

for (const [width, height] of [
  [1440, 900],
  [390, 844]
] as const)
  for (const theme of ["light", "dark"] as const) {
    test(`the overlay lists each note place once, with its dividers, and keeps the toolbar clear (${width}px ${theme})`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      const chatId = await setUp(page, `Plain ${width} ${theme}`, false)
      const overlay = await open(page, chatId)
      const scroll = overlay.getByTestId("preset-scroll")
      // Under Main: a card's prompt can replace it, whether or not one does.
      await expect(overlay.locator('[data-prompt="main"]')).toContainText("A card's own prompt can replace it")

      // "Notes inside the chat" lists each note once, with its depth.
      await expect(overlay.getByText("Tide table", { exact: false })).toHaveCount(1)
      await expect(overlay.getByText("Tide table (depth 2)")).toBeVisible()
      await expect(overlay.getByText("Pilot's log")).toBeVisible()
      await expect(overlay.getByText("Harbor rules")).toBeVisible()
      await expect(overlay.getByText("After the chat: sent last", { exact: true })).toHaveCount(1)
      await expect(overlay.getByText("Tail rule")).toHaveCount(1)
      await page.screenshot({ path: join(shots, `overlay-slots-${width}-${theme}.png`) })

      // Scrolled down, nothing of the document shows above the sticky toolbar.
      await scroll.evaluate((e) => {
        e.scrollTop = e.scrollHeight / 2
      })
      const bar = saveButton(overlay).locator("xpath=ancestor::div[contains(@class,'sticky')][1]")
      const above = await bar.evaluate((element) => {
        const box = element.getBoundingClientRect()
        const scroller = element.closest("[data-preset-scroll]")!
        const parent = scroller.getBoundingClientRect()
        const probes = [box.left + 4, box.left + box.width / 2, box.right - 4]
        return {
          gap: box.top - parent.top,
          covered: probes.map((x) => {
            const hit = document.elementFromPoint(x, Math.max(parent.top + 1, box.top - 3))
            return hit !== null && !element.contains(hit) && scroller.contains(hit)
          })
        }
      })
      expect(above.gap).toBeLessThanOrEqual(0.5)
      expect(above.covered).toEqual([false, false, false])
      await page.screenshot({ path: join(shots, `overlay-scrolled-${width}-${theme}.png`) })
    })
  }

test("with Chat History last the tail still starts after it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const chatId = await setUp(page, "History last", true)
  const overlay = await open(page, chatId)
  await expect(overlay.getByRole("button", { name: "Search and replace", exact: true })).toBeVisible()
  await expect(overlay.getByText("After the chat: sent last", { exact: true })).toHaveCount(1)
  await expect(overlay.getByText("Tail rule")).toHaveCount(1)
  // After Chat History's block, before the end of the document.
  const history = (await overlay.locator('[data-prompt="chatHistory"]').boundingBox())!
  const tail = (await overlay.getByText("After the chat: sent last", { exact: true }).boundingBox())!
  expect(tail.y).toBeGreaterThan(history.y)
})

test("Find's matches go when the question or the text changes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const chatId = await setUp(page, "Find list", false)
  const overlay = await open(page, chatId)
  // The search is folded away until asked for.
  await overlay.getByRole("button", { name: "Search and replace", exact: true }).click()
  const find = overlay.getByRole("textbox", { name: "Find", exact: true })
  const matches = overlay.getByRole("list", { name: "Matches", exact: true })
  await find.fill("narrate")
  await overlay.getByRole("button", { name: "Find", exact: true }).click()
  await expect(matches).toBeVisible()
  // A new question: the old list is gone, not left beside it.
  await find.fill("narrat")
  await expect(matches).toHaveCount(0)
  await overlay.getByRole("button", { name: "Find", exact: true }).click()
  await expect(matches).toBeVisible()
  // Typing in the document: the list is for text that's gone.
  const main = overlay.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })
  await main.click()
  await page.keyboard.press("Control+End")
  await page.keyboard.type(" Narrate once more.")
  await expect(matches).toHaveCount(0)
  await overlay.getByRole("button", { name: "Find", exact: true }).click()
  await expect(matches).toBeVisible()
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`Find opens and selects its match (${width}px ${theme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      const chatId = await setUp(page, `Find navigation ${width} ${theme}`, false)
      const overlay = await open(page, chatId)
      // The search is folded away until asked for.
      await overlay.getByRole("button", { name: "Search and replace", exact: true }).click()
      await overlay.getByRole("button", { name: "Collapse all", exact: true }).click()
      const find = overlay.getByRole("textbox", { name: "Find", exact: true })
      await find.fill("narrate")
      await overlay.getByRole("button", { name: "Find", exact: true }).click()
      const matches = overlay.getByRole("list", { name: "Matches", exact: true })
      await matches
        .getByRole("button", { name: /^Go to / })
        .first()
        .click()
      const main = overlay.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })
      await expect(main).toBeFocused()
      await expect
        .poll(() =>
          main.evaluate((e) =>
            (e.getRootNode() as ShadowRoot & { getSelection: () => Selection | null })
              .getSelection()
              ?.toString()
              .toLowerCase()
          )
        )
        .toBe("narrate")
      const bar = saveButton(overlay).locator("xpath=ancestor::div[contains(@class,'sticky')][1]")
      await expect
        .poll(
          async () => (await main.boundingBox())!.y - ((await bar.boundingBox())!.y + (await bar.boundingBox())!.height)
        )
        .toBeGreaterThanOrEqual(0)
      await page.screenshot({ path: join(shots, `find-navigation-${width}-${theme}.png`) })
      // The result label is also an action; revisiting the same match selects it again.
      await main.press("ArrowRight")
      await matches.getByRole("button", { name: /^Prompt .*Main Prompt.*Content$/ }).click()
      await expect
        .poll(() =>
          main.evaluate((e) =>
            (e.getRootNode() as ShadowRoot & { getSelection: () => Selection | null })
              .getSelection()
              ?.toString()
              .toLowerCase()
          )
        )
        .toBe("narrate")
      await expectSaveState(overlay, NOTHING_TO_SAVE)
    })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`Close and preset identity stay in the toolbar (${width}px ${theme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      const name = `Sticky identity ${width} ${theme}`
      const chatId = await setUp(page, name, false)
      const overlay = await open(page, chatId)
      const scroll = overlay.getByTestId("preset-scroll")
      await scroll.evaluate((e) => {
        e.scrollTop = e.scrollHeight
      })
      const close = overlay.getByRole("button", { name: "Close preset editor", exact: true })
      const bar = close.locator("xpath=ancestor::div[contains(@class,'sticky')][1]")
      await expect(bar.getByText(name, { exact: true })).toBeVisible()
      await expectSaveState(bar, NOTHING_TO_SAVE)
      const box = (await close.boundingBox())!
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y + box.height).toBeLessThan(900)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      await page.screenshot({ path: join(shots, `sticky-close-${width}-${theme}.png`) })
      const main = overlay.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })
      await main.fill("A draft kept while closing the preset.")
      await expectSaveState(bar, UNSAVED)
      await close.click()
      await expect(overlay).toHaveCount(0)
      await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
      const reopened = await open(page, chatId)
      await expect(reopened.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })).toContainText(
        "A draft kept while closing the preset."
      )
    })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`Find reveals and highlights a marker name (${width}px ${theme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      const chatId = await setUp(page, `Marker navigation ${width} ${theme}`, false)
      const overlay = await open(page, chatId)
      // The search is folded away until asked for.
      await overlay.getByRole("button", { name: "Search and replace", exact: true }).click()
      await overlay.getByRole("textbox", { name: "Find", exact: true }).fill("History")
      await overlay.getByRole("button", { name: "Find", exact: true }).click()
      const result = overlay
        .getByRole("list", { name: "Matches", exact: true })
        .getByRole("button", { name: "Go to Prompt “Chat History”: Name", exact: true })
      await result.click()
      const marker = overlay.locator('[data-prompt="chatHistory"]')
      await expect(marker).toBeFocused()
      await expect(marker.locator("mark")).toHaveText("History")
      await page.screenshot({ path: join(shots, `marker-navigation-${width}-${theme}.png`) })
      const bar = saveButton(overlay).locator("xpath=ancestor::div[contains(@class,'sticky')][1]")
      await expect
        .poll(
          async () =>
            (await marker.boundingBox())!.y - ((await bar.boundingBox())!.y + (await bar.boundingBox())!.height)
        )
        .toBeGreaterThanOrEqual(0)
    })

test("Find reveals closed utility prompts and regex script fields", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  const chatId = await setUp(page, "Utility navigation", false)
  const overlay = await open(page, chatId)
  // The search is folded away until asked for.
  await overlay.getByRole("button", { name: "Search and replace", exact: true }).click()
  const find = overlay.getByRole("textbox", { name: "Find", exact: true })
  const submit = overlay.getByRole("button", { name: "Find", exact: true })
  await find.fill("new story")
  await submit.click()
  await overlay.getByRole("button", { name: "Go to Utility prompts: New chat prompt", exact: true }).click()
  const utility = overlay.getByRole("textbox", { name: "New chat", exact: true })
  await expect(utility).toBeFocused()
  await expect
    .poll(() =>
      utility.evaluate((e) =>
        (e.getRootNode() as ShadowRoot & { getSelection: () => Selection | null }).getSelection()?.toString()
      )
    )
    .toBe("new story")

  await overlay.getByRole("button", { name: "Add a script", exact: true }).click()
  await overlay.getByRole("button", { name: "Edit New script", exact: true }).click()
  const pattern = overlay.getByRole("textbox", { name: /^Find \(a regular expression\)/ })
  await pattern.fill("harbour-pattern")
  await overlay.getByRole("button", { name: "Edit New script", exact: true }).click()
  await expect(pattern).toHaveCount(0)
  await find.fill("pattern")
  await submit.click()
  await overlay.getByRole("button", { name: "Go to Regex script “New script”: Find regex", exact: true }).click()
  await expect(pattern).toBeFocused()
  await expect
    .poll(() =>
      pattern.evaluate((e) => {
        const input = e as HTMLInputElement
        return input.value.slice(input.selectionStart!, input.selectionEnd!)
      })
    )
    .toBe("pattern")
})

test("Find reveals an offscreen range inside a long prompt", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  const chatId = await setUp(page, "Long prompt navigation", false)
  const overlay = await open(page, chatId)
  // The search is folded away until asked for.
  await overlay.getByRole("button", { name: "Search and replace", exact: true }).click()
  const main = overlay.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })
  await main.fill(`${"A synthetic line of prompt text.\n".repeat(200)}select this distant range\nLast line.`)
  await overlay.getByRole("button", { name: "Collapse all", exact: true }).click()
  await overlay.getByRole("textbox", { name: "Find", exact: true }).fill("select this distant range")
  await overlay.getByRole("button", { name: "Find", exact: true }).click()
  await overlay.getByRole("button", { name: "Go to Prompt “Main Prompt”: Content", exact: true }).click()
  await expect(main).toBeFocused()
  const bar = saveButton(overlay).locator("xpath=ancestor::div[contains(@class,'sticky')][1]")
  await expect
    .poll(async () => {
      const selected = await main.evaluate((e) => {
        const selection = (e.getRootNode() as ShadowRoot & { getSelection: () => Selection | null }).getSelection()
        const bounds = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null
        return { text: selection?.toString(), top: bounds?.top ?? -1, bottom: bounds?.bottom ?? -1 }
      })
      const toolbar = (await bar.boundingBox())!
      return (
        selected.text === "select this distant range" &&
        selected.top >= toolbar.y + toolbar.height &&
        selected.bottom <= 900
      )
    })
    .toBe(true)
})
