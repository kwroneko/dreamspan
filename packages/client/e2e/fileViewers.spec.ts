// The viewers and the editor (spec/FILES-AND-ENVIRONMENT.md §8.2, track B2) in the browser, on the
// Files page against the real server: Markdown shows rendered and edits as text, with the unsaved
// edit kept as a draft across a reload; Save writes the file and Undo puts it back; a file changed
// on disk while edited shows the conflict (Compare, Load the latest, Save as a copy); CSV shows as
// a table; HTML shows its source and an opt-in preview in the sealed frame, its script never
// running; a PDF draws its pages with pdf.js. Layout audit at 1440 and 390, light and dark.
// Synthetic files only.
import { expect, type Page, test } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { filesOf } from "./support/files.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

/** A one-page PDF with a line of text, its cross-reference offsets computed. */
const minimalPdf = (text: string) => {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ]
  let body = "%PDF-1.4\n"
  const offsets: Array<number> = []
  objects.forEach((object, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, "latin1")
}

const audit = async (page: Page, info: Parameters<typeof expectLayout>[1], name: string) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  if (!process.env.LAYOUT_AUDIT) return
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await expectLayout(page, info, `${name}-${colorScheme}`, { scope: "[data-file-open]" })
  }
  await page.emulateMedia({ colorScheme: "light" })
}

const openFile = (page: Page, folder: string, name: string) =>
  page.goto(`${server().url}/files?${new URLSearchParams({ path: folder, file: name })}`)

for (const width of [1440, 390])
  test(`viewers and the editor at ${width}px`, async ({ page }, info) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const files = filesOf(page.request, server().url)
    // Each width has its own folder: the two run at once on one server.
    const dir = `/files/notes${width}`
    await files.put(`${dir}/plan.md`, "# Lighthouse plan\n\nSynthetic first line.")
    await files.put(`${dir}/keepers.csv`, 'name,post\n"Wren, senior",North light\nAsh,South light\n')
    await files.put(
      `${dir}/page.html`,
      "<!doctype html><html><body><h1>Synthetic page</h1><script>parent.document.title='ran'</script></body></html>"
    )
    await files.put(`${dir}/map.pdf`, minimalPdf("Synthetic lighthouse map"))
    const errors: Array<string> = []
    page.on("pageerror", (error) => errors.push(error.message))

    // Markdown: rendered first; Edit shows the text in the editor.
    await openFile(page, dir, "plan.md")
    const opened = page.locator(`[data-file-open="${dir}/plan.md"]`)
    await expect(opened.locator("[data-file-markdown]").getByRole("heading", { name: "Lighthouse plan" })).toBeVisible()
    await audit(page, info, `viewer-markdown-${width}`)
    await opened.getByRole("button", { name: "Edit" }).click()
    const box = opened.getByRole("textbox", { name: "Contents of plan.md" })
    await expect(box).toContainText("Synthetic first line.")
    await expect(opened.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
    await box.click()
    await page.keyboard.press("ControlOrMeta+End")
    await page.keyboard.type(" Typed in the editor.")
    await expect(opened.locator("[data-file-edit-state]")).toHaveText("Changes not saved to the file")
    await audit(page, info, `viewer-editing-${width}`)

    // The unsaved edit is a draft: a reload finds it, and the file is unchanged.
    await page.reload()
    await opened.getByRole("button", { name: "Edit" }).click()
    await expect(box).toContainText("Typed in the editor.")
    expect(await files.text(`${dir}/plan.md`)).toBe("# Lighthouse plan\n\nSynthetic first line.")

    // Save writes it; Undo puts the earlier text back.
    await opened.getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByText("“plan.md” saved")).toBeVisible()
    expect(await files.text(`${dir}/plan.md`)).toBe("# Lighthouse plan\n\nSynthetic first line. Typed in the editor.")
    await expect(opened.locator("[data-file-edit-state]")).toHaveText("Saved")
    await page.getByRole("button", { name: "Undo" }).click()
    await expect.poll(() => files.text(`${dir}/plan.md`)).toBe("# Lighthouse plan\n\nSynthetic first line.")
    await expect(box).not.toContainText("Typed in the editor.")

    // Changed on disk while edited: Save is off, and the choices are offered.
    await box.click()
    await page.keyboard.press("ControlOrMeta+End")
    await page.keyboard.type(" Mine.")
    await expect(opened.locator("[data-file-edit-state]")).toHaveText("Changes not saved to the file")
    await files.put(`${dir}/plan.md`, "# Lighthouse plan\n\nChanged by a command.")
    const conflict = opened.getByRole("status").filter({ hasText: "This file changed since you started editing" })
    await expect(conflict).toBeVisible()
    await expect(opened.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
    await audit(page, info, `viewer-conflict-${width}`)
    await conflict.getByRole("button", { name: "Compare" }).click()
    const compare = page.getByRole("dialog", { name: "Compare" })
    await expect(compare).toContainText("Changed by a command.")
    await compare.getByRole("button", { name: "Close" }).click()
    await conflict.getByRole("button", { name: "Save as a copy" }).click()
    await expect(page.getByText("Saved as “plan (2).md”")).toBeVisible()
    expect(await files.text(`${dir}/plan (2).md`)).toBe("# Lighthouse plan\n\nSynthetic first line. Mine.")
    expect(await files.text(`${dir}/plan.md`)).toBe("# Lighthouse plan\n\nChanged by a command.")
    await expect(conflict).toHaveCount(0)
    await expect(box).toContainText("Changed by a command.")

    // Load the latest: the edit goes, the file as it is shows.
    await box.click()
    await page.keyboard.press("ControlOrMeta+End")
    await page.keyboard.type(" Again.")
    await files.put(`${dir}/plan.md`, "# Lighthouse plan\n\nChanged once more.")
    await conflict.getByRole("button", { name: "Load the latest" }).click()
    await expect(box).toContainText("Changed once more.")
    await expect(box).not.toContainText("Again.")

    // CSV as a table, quoted commas kept.
    await openFile(page, dir, "keepers.csv")
    const table = page.locator("[data-file-table]")
    await expect(table.getByRole("columnheader")).toHaveText(["name", "post"])
    await expect(table.getByRole("cell", { name: "Wren, senior" })).toBeVisible()
    await audit(page, info, `viewer-table-${width}`)

    // HTML: its source; the preview is opt-in and sealed off, so its script never touches the app.
    await openFile(page, dir, "page.html")
    const html = page.locator(`[data-file-open="${dir}/page.html"]`)
    await expect(html.getByRole("textbox", { name: "Contents of page.html" })).toContainText("<h1>Synthetic page</h1>")
    await html.getByRole("button", { name: "Preview" }).click()
    const frame = html.locator("[data-file-html-preview] iframe")
    await expect(frame).toHaveAttribute("sandbox")
    expect(await frame.getAttribute("sandbox")).not.toContain("allow-same-origin")
    await expect(frame.contentFrame().getByRole("heading", { name: "Synthetic page" })).toBeVisible()
    expect(await page.title()).not.toBe("ran")
    await audit(page, info, `viewer-html-${width}`)

    // PDF: pages drawn by pdf.js, nothing in it run.
    await openFile(page, dir, "map.pdf")
    const pdf = page.locator("[data-file-pdf]")
    await expect(pdf.getByText("1 page")).toBeVisible()
    const canvas = pdf.getByRole("img", { name: "Page 1 of 1" })
    await expect(canvas).toBeVisible()
    await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).width)).toBeGreaterThan(100)
    await audit(page, info, `viewer-pdf-${width}`)
    expect(errors).toEqual([])
  })
