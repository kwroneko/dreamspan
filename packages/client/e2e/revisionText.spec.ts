import { mkdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { asUser } from "./support/rpc.ts"
import { saveRevision } from "./support/saveRevision.ts"
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
        // Select through the editor so replacement uses CodeMirror's document
        // selection rather than fill()'s DOM selection.
        await box.focus()
        await box.press("ControlOrMeta+a")
        await page.keyboard.insertText(after)
        await expectTextBox(box, after)
        // Save asks nothing; what it saved is in History's comparison below.
        await saveRevision(page)
        await expect(page.getByRole("dialog")).toHaveCount(0)
        await mkdir(screens, { recursive: true })
        await page.screenshot({ animations: "disabled", path: join(screens, `${kind}-saved-${width}-${theme}.png`) })
        await page.getByRole("button", { name: "History", exact: true }).click()
        const history = page.getByRole("dialog", { name: "History", exact: true })
        const revisions = history.getByRole("list", { name: "Revisions" }).getByRole("listitem")
        await revisions
          .first()
          .getByRole("button", { name: /^Revision \d+ / })
          .click()
        const change = history.locator("details").first()
        await expect(change).toBeVisible()
        // Closed fields must not allocate merge editors for the whole revision.
        await expect(history.locator(".cm-editor")).toHaveCount(0)
        await change.locator("summary").click()
        await expectTextBox(
          change.getByRole("textbox", { name: width > 639 ? "After" : "Changes", exact: true }),
          after
        )
        if (width > 639) await expectTextBox(change.getByRole("textbox", { name: "Before", exact: true }), before)
        else await expect(change.locator(".cm-deletedChunk").first()).toContainText("burns")
        await change.locator("summary").click()
        await expect(history.locator(".cm-editor")).toHaveCount(0)
        await change.locator("summary").click()
        await page.screenshot({ animations: "disabled", path: join(screens, `${kind}-history-${width}-${theme}.png`) })
        await history.getByRole("tab", { name: "Changes from current state" }).click()
        await expect(history.getByText("No fields differ.", { exact: true })).toBeVisible()
        await revisions
          .nth(1)
          .getByRole("button", { name: /^Revision \d+ / })
          .click()
        await history.getByRole("button", { name: "Restore", exact: true }).click()
        await history.getByRole("button", { name: "Close", exact: true }).click()
        await expectTextBox(box, before)
        await page.reload()
        await expectTextBox(box, before)
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      })
