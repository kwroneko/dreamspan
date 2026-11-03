import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Locator, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { NOTHING_TO_SAVE, expectSaveState, saveRevision } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "80", FAKE_GENERATOR_TOKENS: "80" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = process.env.SCREENSHOT_DIR

// The generic override explanation lives in the slot tag; the option retains its actual value.
const expectOverridesForbidden = async (main: Locator) => {
  const options = main.getByRole("button", { name: "Options of Main Prompt", exact: true })
  const wasOpen = (await options.getAttribute("aria-expanded")) === "true"
  if (!wasOpen) await options.click()
  await expect(main.getByRole("switch", { name: "A card can't replace it", exact: true })).toBeChecked()
  if (!wasOpen) await options.click()
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`create preset, bin capacities and sound ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const shot = async (name: string) => {
        if (shots) {
          mkdirSync(shots, { recursive: true })
          await page.screenshot({
            path: resolve(shots, `${name}-${width}-${theme}.png`),
            fullPage: true,
            animations: "disabled"
          })
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      }
      await page.goto(`${server().url}/library`)
      await page.getByRole("button", { name: "New prompt preset" }).click()
      const dialog = page.getByRole("dialog", { name: "New prompt preset" })
      await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(`Fresh ${width} ${theme}`)
      await shot("new-preset")
      await dialog.getByRole("button", { name: "Create", exact: true }).click()
      await expect(page.getByText("Main Prompt", { exact: true }).filter({ visible: true }).first()).toBeVisible()
      await shot("preset-editor")
      const presets = await admin((api) => api.ListLibrary({ kind: "preset" }))
      const preset = presets.find((p) => p.label === `Fresh ${width} ${theme}`)!
      expect(preset).toBeDefined()
      const main = page.locator('[data-prompt="main"]')
      await expectOverridesForbidden(main)
      const content = `A synthetic instruction at ${width} in ${theme}.`
      await main.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true }).fill(content)
      await saveRevision(page)
      await expectSaveState(page, NOTHING_TO_SAVE)
      await page.goto(`${server().url}/library/${preset.id}`)
      await expectTextBox(page.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true }), content)
      await expectOverridesForbidden(page.locator('[data-prompt="main"]'))

      await page.goto(`${server().url}/bin`)
      await page.getByText("Bin capacity", { exact: true }).click()
      const field = page.getByRole("spinbutton", { name: "Deleted items: item limit", exact: true })
      const capacity = width + (theme === "dark" ? 1 : 0)
      await field.fill(String(capacity))
      await field.locator("xpath=ancestor::form").getByRole("button", { name: "Save", exact: true }).click()
      await expect(
        field.locator("xpath=ancestor::form").getByRole("button", { name: "Save", exact: true })
      ).toBeDisabled()
      await shot("bin-capacity")
      await page.reload()
      await page.getByText("Bin capacity", { exact: true }).click()
      await expect(field).toHaveValue(String(capacity))

      await page.goto(`${server().url}/settings/notifications`)
      const sound = page.getByRole("switch", { name: /^Completion sound/ })
      await expect(sound).not.toBeChecked()
      await sound.click()
      await expect(sound).toBeChecked()
      await page.reload()
      await expect(sound).toBeChecked()
      await shot("sound")
    })
  }

test("only unseen completions play sound after activation; disabling it silences later replies", async ({ page }) => {
  await page.addInitScript(() => {
    let played = 0
    Object.assign(window, { soundCount: () => played })
    const create = AudioContext.prototype.createOscillator
    AudioContext.prototype.createOscillator = function () {
      played++
      return create.call(this)
    }
  })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/notifications`)
  await page.getByRole("switch", { name: /^Completion sound/ }).click()
  const reply = () =>
    admin((api) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateChat({ title: "Sound elsewhere" })
        yield* api.Generate({ chatId: chat.id, parentSlotId: null, branch: false })
      })
    )
  await reply()
  await expect.poll(() => page.evaluate(() => (window as unknown as { soundCount: () => number }).soundCount())).toBe(1)
  await page.getByRole("switch", { name: /^Completion sound/ }).click()
  await reply()
  await expect(page).toHaveTitle(/^\(2\)/)
  expect(await page.evaluate(() => (window as unknown as { soundCount: () => number }).soundCount())).toBe(1)
})

test("saved sound skips completions before interaction and touch activation never plays them late", async ({
  browser
}) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
  try {
    await context.addInitScript(() => {
      localStorage.setItem("rp.notifications.sound", "on")
      let played = 0
      Object.assign(window, { soundCount: () => played })
      const create = AudioContext.prototype.createOscillator
      AudioContext.prototype.createOscillator = function () {
        played++
        return create.call(this)
      }
    })
    await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
    const page = await context.newPage()
    await page.goto(`${server().url}/settings/notifications`)
    await expect(page.getByRole("switch", { name: /^Completion sound/ })).toBeChecked()
    const reply = () =>
      admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: "Touch activation" })
          yield* api.Generate({ chatId: chat.id, parentSlotId: null, branch: false })
        })
      )
    const count = () => page.evaluate(() => (window as unknown as { soundCount: () => number }).soundCount())
    await reply()
    await expect(page).toHaveTitle(/^\(1\)/)
    expect(await count()).toBe(0)
    // The card's heading, not a control: a phone's settings page also titles itself "Notifications".
    await page.getByRole("heading", { level: 2, name: "Notifications", exact: true }).tap()
    expect(await count()).toBe(0)
    await reply()
    await expect.poll(count).toBe(1)
    await expect(page).toHaveTitle(/^\(2\)/)
  } finally {
    await context.close()
  }
})
