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
