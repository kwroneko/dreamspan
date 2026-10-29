import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { expect, test } from "@playwright/test"
import { join } from "node:path"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const shots = "~/projects/work-folder/2026-10-28/night/bl-o/screens"
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`custom cost formulas ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/settings/costs`)
      await expect(page.getByRole("heading", { name: "Costs", exact: true })).toBeVisible()
      const remove = page.getByRole("button", { name: "Remove formula", exact: true })
      while (await remove.count()) await remove.first().click()
      await page.getByRole("button", { name: "Add formula", exact: true }).click()
      await page.getByLabel("Name", { exact: true }).fill("Private contract")
      await page.getByLabel("Model", { exact: true }).fill("vendor/storyteller")
      await page.getByLabel("Provider kind", { exact: true }).fill("openrouter")
      await page.getByLabel("Upstream", { exact: true }).fill("Fireworks")
      await page.getByLabel("Currency label", { exact: true }).fill("credits")
      await page.getByLabel("Uncached input", { exact: true }).fill("2")
      await page.getByLabel("Cache read", { exact: true }).fill("0.2")
      await page.getByLabel("Cache write", { exact: true }).fill("2.5")
      await page.getByLabel("Long cache write", { exact: true }).fill("4")
      await page.getByLabel("Output", { exact: true }).fill("8")
      await page.getByRole("button", { name: "Add context tier" }).click()
      await page.getByLabel("Total input above", { exact: true }).fill("128000")
      await page.getByLabel("Uncached input", { exact: true }).nth(1).fill("4")
      await page.getByRole("button", { name: "Save pricing", exact: true }).click()
      await expect(page.getByText("Saved. New requests use these prices; past costs stay as recorded.")).toBeVisible()
      await page.reload()
      await expect(page.getByLabel("Model", { exact: true })).toHaveValue("vendor/storyteller")
      await expect(page.getByLabel("Total input above", { exact: true })).toHaveValue("128000")
      await expect(page.getByLabel("Uncached input", { exact: true }).nth(1)).toHaveValue("4")
      // Unapplied edits survive reload through a server draft.
      await page.getByLabel("Name", { exact: true }).fill("Private contract draft")
      await page.waitForTimeout(800)
      await page.reload()
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Private contract draft")
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.GetCostSettings().pipe(
          Effect.flatMap((current) =>
            api.SetCostSettings({
              expectedRevision: current.revision,
              rules: current.rules.map((r) => ({ ...r, name: "Changed elsewhere" }))
            })
          )
        )
      )
      await page.reload()
      await expect(page.getByText(/Pricing changed in another tab/)).toBeVisible()
      await page.getByRole("button", { name: "Save pricing", exact: true }).click()
      await expect(page.getByRole("alert").filter({ hasText: "Pricing wasn't saved" })).toBeVisible()
      await page.getByRole("button", { name: "Keep my rules on the latest version" }).click()
      await page.getByRole("button", { name: "Save pricing", exact: true }).click()
      await expect(page.getByText("Saved. New requests use these prices; past costs stay as recorded.")).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
      await page.screenshot({ path: join(shots, `costs-${width}-${theme}-rates.png`), fullPage: true })
      await page.getByRole("heading", { name: "Costs", exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(shots, `costs-${width}-${theme}.png`), fullPage: true })
      await page.getByRole("button", { name: "Remove formula", exact: true }).click()
      await page.getByRole("button", { name: "Save pricing", exact: true }).click()
      await expect(page.getByText("Saved. New requests use these prices; past costs stay as recorded.")).toBeVisible()
      await page.reload()
      await expect(
        page.getByText("No custom formulas. Provider-reported costs and built-in model prices apply.")
      ).toBeVisible()
    })
  }
