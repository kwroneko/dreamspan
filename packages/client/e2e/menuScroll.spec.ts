// Synthetic cards only: a menu opened from a row of a scrolling list closes when the list
// scrolls (ui/anchorScroll.ts), rather than following its row out of the list. Both persona
// pickers of a new chat, whose persona rows each have a "…" menu.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { openPanel } from "./support/panel.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

test.describe("row menus in a scrolling list", () => {
  test.setTimeout(120_000)
  const server = serverPerFile(withAdmin)

  /** Opens the first persona row's menu in `picker`, scrolls the picker's list, and expects the menu gone. */
  const scrollCloses = async (page: Page, picker: Locator) => {
    const list = picker.getByRole("listbox")
    const trigger = list.getByRole("button", { name: /^Persona actions for / }).first()
    const label = (await trigger.getAttribute("aria-label"))!
    await trigger.click()
    const menu = page.getByRole("menu", { name: label, exact: true })
    await expect(menu.getByRole("menuitem", { name: "Set as default persona" })).toBeVisible()
    // One pixel at a time still closes the menu when the row leaves view.
    await list.evaluate(async (element, name) => {
      const button = element.querySelector(`[aria-label="${name}"]`)!
      while (button.getBoundingClientRect().bottom > element.getBoundingClientRect().top) {
        element.scrollTop++
        await new Promise(requestAnimationFrame)
      }
    }, label)
    await expect(menu).toHaveCount(0)
    await expect(picker).toBeVisible()

    // Opened from the keyboard on a half-hidden row, the list scrolls to show it: the menu stays.
    // Scrolled so half the first row's … is above the list's top edge.
    await list.evaluate(
      (element, name) =>
        new Promise((done) => {
          element.scrollTop = 0
          const button = element.querySelector(`[aria-label="${name}"]`)!.getBoundingClientRect()
          element.scrollTop = button.top - element.getBoundingClientRect().top + button.height / 2
          requestAnimationFrame(() => requestAnimationFrame(done))
        }),
      label
    )
    const half = list.getByRole("button", { name: label, exact: true })
    expect((await half.boundingBox())!.y).toBeLessThan((await list.boundingBox())!.y)
    await half.press("Enter")
    const lowerMenu = page.getByRole("menu", { name: label, exact: true })
    await expect(lowerMenu).toBeVisible()
    await page.waitForTimeout(300)
    await expect(lowerMenu).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(lowerMenu).toHaveCount(0)
  }

  for (const width of [1440, 390])
    test(`a persona row's menu closes as its picker's list scrolls ${width}`, async ({ page }) => {
      const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
      const { harbor } = await withCookie(server(), cookie, (api) =>
        Effect.gen(function* () {
          const harbor = yield* api.CreateCard({ label: `Harbor ${width}`, name: `Harbor ${width}` })
          for (let at = 0; at < 14; at++) {
            const card = yield* api.CreateCard({ label: `Aide ${width} ${at}`, name: `Aide ${width} ${at}` })
            yield* api.SetPersona({ entityId: card.entityId, persona: true })
          }
          return { harbor }
        })
      )
      await page.setViewportSize({ width, height: 900 })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/cards/${harbor.entityId}/chat`)

      // The composer's Speak as picker.
      await page.getByRole("button", { name: /^Speaking as .*\. Change the speaker$/ }).click()
      const composer = page.getByRole("dialog", { name: "Speak as" })
      await scrollCloses(page, composer)
      await composer.getByRole("combobox").press("Escape")
      await expect(composer).toHaveCount(0)

      // The Cast tab's persona picker.
      await openPanel(page, "Cast")
      await page.getByRole("button", { name: /^Playing as .*\. Change your persona$/ }).click()
      const cast = page.getByRole("dialog", { name: "Your persona" })
      await scrollCloses(page, cast)
    })
})
