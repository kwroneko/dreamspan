import { mkdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { expect, test } from "@playwright/test"
import { saveRevision } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const shots = resolve(process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-preset-text-switches"))
mkdirSync(shots, { recursive: true })
const preset = JSON.parse(
  readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
)

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`prompt switches persist in drafts and revisions (${width}px ${theme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const response = await page.request.post(`${server().url}/library/import?name=switches.json`, {
        headers: { origin: server().url, "content-type": "application/octet-stream" },
        data: Buffer.from(JSON.stringify(preset))
      })
      expect(response.status()).toBe(200)
      const ref = ((await response.json()) as { library: { ref: { id: string } } }).library.ref.id
      await page.goto(`${server().url}/library/${ref}`)
      const names = [
        "Pin example dialogues",
        "Strip example dialogues",
        "Collapse blank lines in character fields"
      ] as const
      for (const name of names) {
        const control = page.getByRole("switch", { name, exact: true })
        await expect(control).not.toBeChecked()
        await control.click()
        await expect(control).toBeChecked()
      }
      await expect(page.getByRole("status").filter({ hasText: /^Changed since revision \d+$/ })).toBeVisible()
      await page.reload()
      for (const name of names) await expect(page.getByRole("switch", { name, exact: true })).toBeChecked()
      await saveRevision(page)
      await expect(page.getByText("Saved a revision.")).toBeVisible()
      await page.reload()
      for (const name of names) await expect(page.getByRole("switch", { name, exact: true })).toBeChecked()
      await page.getByRole("switch", { name: names[0], exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(shots, `text-switches-${width}-${theme}.png`) })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
