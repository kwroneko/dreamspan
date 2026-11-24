// "New workshop with this card" (spec/WORKSHOP-CARDS.md §3, unit C1): a character's More menu in
// the library offers it with its explanation, and it opens the workshop not made yet with that card
// as the assistant; a persona's menu doesn't offer it. Synthetic cards only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = process.env.SCREENSHOT_DIR
test.setTimeout(120_000)

for (const width of [1340, 390])
  for (const theme of ["dark", "light"] as const)
    test(`a card's menu starts a workshop with it at ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const shot = async (name: string) => {
        if (shots) {
          mkdirSync(shots, { recursive: true })
          await page.waitForTimeout(200)
          await page.screenshot({ path: resolve(shots, `withcard-${name}-${width}-${theme}.png`) })
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      }
      const name = `Cardsmith ${width} ${theme}`
      const card = await admin((api) => api.CreateCard({ label: name, name, description: "Writes tidy cards." }))
      const persona = await admin((api) =>
        api.CreateCard({ label: `Rover ${width} ${theme}`, name: `Rover ${width} ${theme}`, persona: true })
      )

      await page.goto(`${server().url}/library`)
      await page.getByRole("button", { name: `More actions for ${name}`, exact: true }).click()
      const item = page.getByRole("menuitem", { name: "New workshop with this card", exact: true })
      await item.focus()
      await expect(item).toHaveAccessibleDescription(
        "Starts a workshop whose assistant is this card, as a story starts with a character."
      )
      await shot("menu")
      await expectLayout(page, info, `withcard-menu-${width}-${theme}`, { hovered: true })
      await item.click()
      await expect(page).toHaveURL(new RegExp(`/new/workshop\\?.*workshopCard=${card.entityId}`))
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible()
      await shot("start")
      await expectLayout(page, info, `withcard-start-${width}-${theme}`)

      // A persona isn't an assistant: its menu doesn't offer it.
      await page.goto(`${server().url}/library?show=personas`)
      await page.getByRole("button", { name: `More actions for ${persona.label}`, exact: true }).click()
      await expect(page.getByRole("menuitem", { name: "Set as workshop persona", exact: true })).toBeVisible()
      await expect(page.getByRole("menuitem", { name: "New workshop with this card", exact: true })).toHaveCount(0)
      await page.keyboard.press("Escape")
    })
