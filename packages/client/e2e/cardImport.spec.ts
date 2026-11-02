// "Import a new version…" of a card (ARCHITECTURE.md §11.1) in a real browser against the
// real server: the card's editor, a new version's file picked, the preview's changed field
// and what's kept, Replace, the editor showing the new text, and History with the revision.
// Every card here is made up, built in the test.
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { crc32, deflateSync } from "node:zlib"
import { expect, type Page, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"
import { NOTHING_TO_SAVE, saveCluster } from "./support/saveRevision.ts"

const server = serverPerFile(withAdmin)
const screens = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-card-import-screens")

const pngChunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(12 + data.byteLength)
  out.writeUInt32BE(data.byteLength, 0)
  out.write(type, 4, "latin1")
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.byteLength)), 8 + data.byteLength)
  return out
}

/** A 1×1 PNG of grey `shade` carrying `card` in a `chara` chunk, as ST writes one. */
const cardPng = (card: unknown, shade: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
    pngChunk("IDAT", deflateSync(Buffer.from([0, shade]))),
    pngChunk("tEXt", Buffer.from(`chara\0${Buffer.from(JSON.stringify(card)).toString("base64")}`, "latin1")),
    pngChunk("IEND", Buffer.alloc(0))
  ])

const card = (description: string, note: string) => ({
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "Wren",
    description,
    first_mes: "The lamp needs oil.",
    extensions: { depth_prompt: { prompt: note, depth: 4, role: "system" } }
  }
})

const field = (page: Page, name: string) => page.getByRole("textbox", { name: new RegExp(`^${name}`) })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a card takes a new version of its file wholesale ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 960 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const response = await page.request.post(`${server().url}/library/import?name=wren.png`, {
        headers: { "content-type": "application/octet-stream", origin: server().url },
        data: cardPng(card("A lighthouse keeper.", "Wren smells of oil."), 128)
      })
      expect(response.status()).toBe(200)
      const refId = ((await response.json()) as { library: { ref: { id: string } } }).library.ref.id

      await page.goto(`${server().url}/library/${refId}`)
      await expect(saveCluster(page).first()).toHaveAttribute("data-save-state", NOTHING_TO_SAVE)
      // In the header itself, beside Fork and Export….
      await page.getByRole("button", { name: "Import a new version…", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Import a new version of Wren" })
      await expect(dialog).toBeVisible()
      await dialog.getByLabel(/^Choose the new version's file/).setInputFiles({
        name: "wren-2.png",
        mimeType: "image/png",
        buffer: cardPng(card("A retired lighthouse keeper.", "Wren smells of salt."), 40)
      })
      const changes = dialog.getByRole("list", { name: "Changed fields" })
      await expect(changes.locator("summary")).toContainText(["Description"])
      await expect(changes).toContainText("retired")
      const kept = dialog.getByRole("list", { name: "Kept from this card" })
      await expect(kept).toContainText("Its notes, as they are.")
      await expect(dialog.getByRole("list", { name: "Also note" })).toContainText(
        "The file carries a Character's Note that differs"
      )
      await expect(dialog.getByText("No chat follows this card yet.")).toBeVisible()
      await expect(dialog.getByText(/History → restore revision 1 undoes it/)).toBeVisible()
      // Both pictures load: the file's from the preview's bytes, under the page's CSP.
      for (const name of ["The file's picture", "The card's picture now"])
        await expect
          .poll(() => dialog.getByRole("img", { name }).evaluate((img: HTMLImageElement) => img.naturalWidth))
          .toBeGreaterThan(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
      await mkdir(screens, { recursive: true })
      await page.screenshot({ animations: "disabled", path: join(screens, `preview-${width}-${theme}.png`) })

      await dialog.getByRole("button", { name: "Replace", exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expectTextBox(field(page, "Description"), "A retired lighthouse keeper.")
      await expect(saveCluster(page).first()).toHaveAttribute("data-save-state", NOTHING_TO_SAVE)

      await page.getByRole("button", { name: "History", exact: true }).click()
      const history = page.getByRole("dialog", { name: "History" })
      const revisions = history.getByRole("list", { name: "Revisions" }).getByRole("listitem")
      await expect(revisions).toHaveCount(2)
      await expect(revisions.first()).toContainText("Replaced with a new version from wren-2.png")
    })
