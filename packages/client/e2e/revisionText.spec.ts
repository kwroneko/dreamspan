import { mkdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const screens = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-revision-text-screens")
const before = "A quiet harbor.\nThe lamp burns.\n" + "Keep this unchanged line.\n".repeat(90) + "End of original."
const after = before.replace("burns", "flickers").replace("End of original.", "End of revision.")

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    for (const kind of ["note", "preset"] as const)
      test(`${kind} full save and history comparisons ${width} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 960 })
        await page.emulateMedia({ colorScheme: theme })
        await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        let id: string
        if (kind === "note") {
          id = (await admin((api) => api.CreateSharedNote({ title: "Harbor note", content: before }))).id
        } else {
          const preset = JSON.parse(
            await readFile(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
          )
          preset.prompts.find((prompt: { identifier: string }) => prompt.identifier === "main").content = before
          const name = `Harbor preset ${width} ${theme}`
          const response = await page.request.post(
            `${server().url}/library/import?name=${encodeURIComponent(name)}.json`,
            {
              data: Buffer.from(JSON.stringify(preset)),
              headers: { origin: server().url, "content-type": "application/octet-stream" }
            }
          )
          expect(response.status()).toBe(200)
          id = (await admin((api) => api.ListLibrary({ kind: "preset" }))).find((ref) => ref.label === name)!.id
        }
        await page.goto(`${server().url}/library/${id}`)
        const box = page.getByRole("textbox", {
          name: kind === "note" ? "Content" : "Prompt: Main Prompt",
          exact: true
        })
        await expectTextBox(box, before)
        await box.fill(after)
        await page.getByRole("button", { name: /^Save \(/ }).click()
        const save = page.getByRole("dialog", { name: "Save a revision" })
        await expectTextBox(save.getByRole("textbox", { name: width > 639 ? "After" : "Changes", exact: true }), after)
        if (width > 639) await expectTextBox(save.getByRole("textbox", { name: "Before", exact: true }), before)
        else await expect(save.locator(".cm-deletedChunk").first()).toContainText("burns")
        await mkdir(screens, { recursive: true })
        await page.screenshot({ animations: "disabled", path: join(screens, `${kind}-save-${width}-${theme}.png`) })
        await save.getByRole("button", { name: "Save revision", exact: true }).click()
        await expect(save).toHaveCount(0)
        await page.getByRole("button", { name: "History", exact: true }).click()
        const history = page.getByRole("dialog", { name: "History", exact: true })
        const revisions = history.getByRole("list", { name: "Revisions" }).getByRole("listitem")
        await revisions.first().getByRole("button").click()
        const change = history.locator("details").first()
        await change.locator("summary").click()
        await expectTextBox(
          change.getByRole("textbox", { name: width > 639 ? "After" : "Changes", exact: true }),
          after
        )
        await page.screenshot({ animations: "disabled", path: join(screens, `${kind}-history-${width}-${theme}.png`) })
        await history.getByRole("radio", { name: "Current draft / head" }).click()
        await expect(history.getByText("No fields differ.", { exact: true })).toBeVisible()
        await revisions.nth(1).getByRole("button").click()
        await history.getByRole("button", { name: "Restore", exact: true }).click()
        await history.getByRole("button", { name: "Close", exact: true }).click()
        await expectTextBox(box, before)
        await page.reload()
        await expectTextBox(box, before)
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      })
