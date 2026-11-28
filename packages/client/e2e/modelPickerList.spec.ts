// The model picker on a daily user's catalog (support/pickerCatalog.ts): searching needs every
// typed word, "No model" is a row of the list, pins toggle and lead, the sort is a labelled
// choice beside the connection filter. LAYOUT_AUDIT=1 adds the layout audit at three widths in
// both themes; SHOTS_DIR saves a screenshot of each state there.
import { test, expect, type Page } from "@playwright/test"
import { join } from "node:path"
import { pickerCatalog } from "./support/pickerCatalog.ts"
import { serverPerFile } from "./support/server.ts"
import { withCookie } from "./support/rpc.ts"
import { filterModels, modelChip, sortModels } from "./support/strip.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile()
let catalog: Awaited<ReturnType<typeof pickerCatalog>>
const seed = () => withCookie(server(), "", catalog.seed)
let seeded: Awaited<ReturnType<typeof seed>>
test.beforeAll(async () => {
  catalog = await pickerCatalog()
  seeded = await seed()
})
test.afterAll(async () => {
  await catalog?.stop()
})
test.use({ reducedMotion: "reduce" })

const list = (page: Page) => page.getByRole("radiogroup", { name: "Model", exact: true })
const heading = (page: Page, text: string) => list(page).locator("[data-model-heading]", { hasText: text })
const search = (page: Page) => page.getByRole("searchbox", { name: "Find a model", exact: true })
const names = (page: Page) =>
  list(page)
    .getByRole("radio")
    .evaluateAll((els) => els.map((el) => el.ariaLabel))

test("search lists only models matching every word, best first", async ({ page }) => {
  await page.goto(`${server().url}/chats/${seeded.chat.id}`)
  await modelChip(page).click()
  await search(page).fill("gemini neon")
  await expect(list(page).getByRole("radio")).toHaveCount(2)
  expect(await names(page)).toEqual(["Gateway UNO · uno.gemini-4-neon", "Gateway UNO · uno.gemini-4-neon-lite"])
  // A word in the connection's name counts too; a word nothing has empties the list.
  await search(page).fill("local neon")
  expect(await names(page)).toEqual(["Local box · neon-7b"])
  await search(page).fill("gemini zzz")
  await expect(list(page).getByText("No matching models.")).toBeVisible()
})

test("No model is a row of the list, chosen like a model", async ({ page }) => {
  await page.goto(`${server().url}/settings/chats`)
  const field = page.getByRole("button", { name: "Refusal judge", exact: true })
  await field.click()
  const none = list(page).getByRole("radio", { name: "No model", exact: true })
  await expect(none).toHaveAccessibleDescription("Only refusals the provider reports are caught.")
  await expect(none).toHaveAttribute("aria-checked", "true")
  // It's the first row, and Up from it returns to the search.
  await search(page).focus()
  await page.keyboard.press("ArrowDown")
  await expect(none).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(list(page).getByRole("radio").nth(1)).toBeFocused()
  await page.keyboard.press("ArrowUp")
  await page.keyboard.press("ArrowUp")
  await expect(search(page)).toBeFocused()
  // Searching lists only models.
  await search(page).fill("neon")
  await expect(none).toHaveCount(0)
  await list(page).getByRole("radio", { name: "Local box · neon-7b", exact: true }).click()
  await expect(field).toContainText("Local box · neon-7b")
  await field.click()
  await list(page).getByRole("radio", { name: "No model", exact: true }).click()
  await expect(field).toContainText("No model")
  await expect
    .poll(() => withCookie(server(), "", (api) => api.GetGenerationDefaults()).then((d) => d.judge ?? null))
    .toBe(null)
})

test("a pin toggles in place and leads the list on reopening", async ({ page }) => {
  await page.goto(`${server().url}/chats/${seeded.chat.id}`)
  await modelChip(page).click()
  await search(page).fill("gpt tale 7")
  const pin = list(page).getByRole("button", { name: "Pin Gateway UNO · uno.gpt-tale-7", exact: true })
  await expect(pin).toHaveAttribute("aria-pressed", "false")
  await pin.click()
  const unpin = list(page).getByRole("button", { name: "Unpin Gateway UNO · uno.gpt-tale-7", exact: true })
  await expect(unpin).toHaveAttribute("aria-pressed", "true")
  await page.keyboard.press("Escape")
  await modelChip(page).click()
  await expect(heading(page, "Pinned")).toBeVisible()
  const pinned = (await names(page)).slice(0, 4)
  expect(pinned).toContain("Gateway UNO · uno.gpt-tale-7")
  expect(pinned).toContain("Gateway UNO · uno.gemini-4-argon")
  await unpin.click()
  await expect(pin).toHaveAttribute("aria-pressed", "false")
})

test("a pin on a named model of a second connection joins Pinned once the search changes or clears", async ({
  page
}) => {
  await page.goto(`${server().url}/chats/${seeded.chat.id}`)
  await modelChip(page).click()
  await search(page).fill("storyteller 007")
  const label = "Router catalog · openai/story-007-v3.1"
  await list(page)
    .getByRole("button", { name: `Pin ${label}`, exact: true })
    .click()
  const unpin = list(page).getByRole("button", { name: `Unpin ${label}`, exact: true })
  await expect(unpin).toHaveAttribute("aria-pressed", "true")
  await search(page).fill("storyteller 00")
  await expect(heading(page, "Pinned")).toBeVisible()
  expect((await names(page)).slice(0, 2).sort()).toEqual(["Router catalog · anthropic/story-000-v3.1", label].sort())
  await search(page).fill("")
  await expect(heading(page, "Pinned")).toBeVisible()
  expect((await names(page)).slice(0, 4)).toContain(label)
  await unpin.click()
  await expect(list(page).getByRole("button", { name: `Pin ${label}`, exact: true })).toHaveAttribute(
    "aria-pressed",
    "false"
  )
})

test("pins that load after the picker opens, or change in another tab, join Pinned at once", async ({ page }) => {
  const label = "Router catalog · mistralai/story-010-v3.1"
  const other = "Router catalog · deepseek/story-017-v3.1"
  const pinRow = (on: Page, name: string, pinned: boolean) =>
    list(on).getByRole("button", { name: `${pinned ? "Unpin" : "Pin"} ${name}`, exact: true })
  // Pinned before the picker opens.
  await page.goto(`${server().url}/chats/${seeded.chat.id}`)
  await modelChip(page).click()
  await search(page).fill("storyteller 010")
  await pinRow(page, label, false).click()
  await expect(pinRow(page, label, true)).toHaveAttribute("aria-pressed", "true")
  // Reopened on a fresh page whose pins arrive only after the picker shows.
  let holding = true
  const held: Array<() => void> = []
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string }) : null
      if (request?.tag === "GetDisplayPrefs" && holding) {
        held.push(() => upstream.send(data))
        return
      }
      upstream.send(data)
    })
    upstream.onMessage((data) => socket.send(data))
  })
  await page.goto(`${server().url}/chats/${seeded.chat.id}`)
  await modelChip(page).click()
  await expect(list(page)).toBeVisible()
  await expect.poll(() => held.length).toBeGreaterThan(0)
  await expect(heading(page, "Pinned")).toHaveCount(0)
  holding = false
  for (const send of held.splice(0)) send()
  await expect(heading(page, "Pinned")).toBeVisible()
  await expect.poll(async () => (await names(page)).slice(0, 4)).toContain(label)
  // Pinned in another tab while this picker stays open, its search unchanged.
  const second = await page.context().newPage()
  await second.goto(`${server().url}/chats/${seeded.chat.id}`)
  await modelChip(second).click()
  await search(second).fill("storyteller 017")
  await pinRow(second, other, false).click()
  await expect(pinRow(second, other, true)).toHaveAttribute("aria-pressed", "true")
  await expect.poll(async () => (await names(page)).slice(0, 5)).toContain(other)
  await pinRow(second, other, true).click()
  await expect(pinRow(second, other, false)).toHaveAttribute("aria-pressed", "false")
  await second.close()
  await expect.poll(async () => (await names(page)).slice(0, 5)).not.toContain(other)
  await pinRow(page, label, true).click()
  await expect(pinRow(page, label, false)).toHaveAttribute("aria-pressed", "false")
})

test("the focused row keeps focus when pins arriving elsewhere push it down the list", async ({ page }) => {
  const current = "Gateway UNO · uno.gemini-4-carbon"
  const value = seeded.value(0, "uno.gemini-4-carbon")
  // Twelve more pins above the chosen row move it well past the rows that were in view.
  const added = Array.from({ length: 12 }, (_, i) => {
    const author = ["anthropic", "openai", "meta-llama", "qwen", "mistralai", "deepseek"][i % 6]!
    return seeded.value(1, `${author}/story-${String(30 + i).padStart(3, "0")}-v3.1`)
  })
  // Set from outside this page, then announced to it as another tab announces its own changes.
  const other = await page.context().newPage()
  await other.goto(`${server().url}/chats/${seeded.chat.id}`)
  const setPins = async (pinned: boolean) => {
    await withCookie(server(), "", (api) =>
      api.SetDisplayPrefs({ prefs: { modelPins: Object.fromEntries(added.map((id) => [id, pinned])) } })
    )
    await other.evaluate(() => new BroadcastChannel("dreamspan.displayPrefs").postMessage("changed"))
  }
  // The chosen row's place in the list, or null while it isn't mounted.
  const index = () =>
    list(page)
      .locator("[data-picker-row]")
      .evaluateAll((els, chosen) => {
        const el = els.find((each) => (each as HTMLElement).dataset.pickerRow === chosen) as HTMLElement | undefined
        return el ? Number(el.dataset.modelIndex) : null
      }, value)
  const row = list(page).getByRole("radio", { name: current, exact: true })
  await page.goto(`${server().url}/chats/${seeded.chat.id}`)
  await modelChip(page).click()
  await search(page).focus()
  await page.keyboard.press("ArrowDown")
  await expect(row).toBeFocused()
  const start = (await index())!
  try {
    await setPins(true)
    await expect.poll(index).toBe(start + added.length)
    await expect(row).toBeFocused()
    await expect(row).toBeInViewport()
    // Arrow keys go on from the same row.
    await page.keyboard.press("ArrowDown")
    await expect(list(page).getByRole("radio", { name: `${current}-lite`, exact: true })).toBeFocused()
    await page.keyboard.press("ArrowUp")
    await expect(row).toBeFocused()
    // The pins leaving again move it back up, and focus stays with it.
    await setPins(false)
    await expect.poll(index).toBe(start)
    await expect(row).toBeFocused()
    await expect(row).toBeInViewport()
  } finally {
    await setPins(false)
    await other.close()
  }
})

test("the sort is a labelled choice beside the connection filter", async ({ page }) => {
  await page.goto(`${server().url}/chats/${seeded.chat.id}`)
  await modelChip(page).click()
  const sort = page.getByRole("combobox", { name: "Sort models", exact: true })
  await expect(sort).toHaveText("Sort: Name")
  await filterModels(page, "Router catalog")
  // Pinned, then Recent, then the rest of the connection under its name.
  await expect(heading(page, "Router catalog")).toBeVisible()
  const byName = await names(page)
  expect(byName.slice(0, 3)).toEqual([
    "Router catalog · anthropic/story-000-v3.1",
    "Router catalog · qwen/story-003-v3.1",
    "Router catalog · deepseek/story-011-v3.1"
  ])
  await sortModels(page, "Last used")
  await expect(sort).toHaveText("Sort: Last used")
  await expect
    .poll(() => withCookie(server(), "", (api) => api.GetDisplayPrefs({})).then((prefs) => prefs.modelSort))
    .toBe("used")
  await filterModels(page, "All connections")
  await expect(page.getByRole("combobox", { name: "Connection", exact: true })).toHaveText("All connections")
  await expect(heading(page, "Pinned")).toBeVisible()
  await sortModels(page, "Name")
})

if (process.env.LAYOUT_AUDIT || process.env.SHOTS_DIR)
  for (const width of [390, 600, 1440])
    for (const theme of ["light", "dark"] as const)
      test(`layout ${width} ${theme}`, async ({ page }, info) => {
        const shot = async (name: string) => {
          if (process.env.LAYOUT_AUDIT)
            await expectLayout(page, info, `${name}-${width}-${theme}`, { scope: "[data-model-picker]" })
          if (process.env.SHOTS_DIR)
            await page.screenshot({ path: join(process.env.SHOTS_DIR, `after-${name}-${width}-${theme}.png`) })
        }
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme })
        await page.goto(`${server().url}/chats/${seeded.chat.id}`)
        await expect(modelChip(page)).toBeEnabled()
        await modelChip(page).click()
        await expect(list(page)).toBeVisible()
        await shot("composer")
        await search(page).fill("gemini neon")
        await expect(list(page).getByRole("radio")).toHaveCount(2)
        await shot("search")
        await page.keyboard.press("Escape")
        await page.goto(`${server().url}/settings/chats`)
        await page.getByRole("button", { name: "Default model", exact: true }).click()
        await expect(list(page)).toBeVisible()
        await shot("settings")
        // The chosen row in view: the judge's No model.
        await page.keyboard.press("Escape")
        await page.getByRole("button", { name: "Refusal judge", exact: true }).click()
        await expect(list(page).getByRole("radio", { name: "No model", exact: true })).toBeVisible()
        await shot("chosen")
      })
