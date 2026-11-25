// Attachments of any type in workshops (spec/FILES-AND-ENVIRONMENT.md §6.1, track A3) in the
// browser: remove an unsent file, reload with a draft attachment, then send it.
// The Files tab's Attach to message attaches a file as it is; the sent message lists both
// by name, opening the copy as sent in its viewer (with Download there), and Show in Files; the model is told where each one is.
// Layout audit at 1440 and 390, light and dark. A scripted loopback provider and synthetic files.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { filesOf } from "./support/files.ts"
import { openPanel } from "./support/panel.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startWorkshopProvider } from "./support/workshopProvider.ts"

const server = serverPerFile(withAdmin)
let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, use)

test.beforeAll(async () => {
  provider = await startWorkshopProvider({
    perTask: true,
    calls: [],
    // The answer says which attachment lines the request carried.
    answer: (body) => {
      const text = JSON.stringify(body.messages)
      const seen = ["notes", "outline"].filter((name) => text.includes(`path=\\"/attachments/`) && text.includes(name))
      return seen.length === 2 && text.includes('file_path=\\"/files/Attachments/notes.txt\\"')
        ? "I can see notes.txt and outline.md."
        : "No attachments came through."
    }
  })
  await admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic workshop",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "workshop-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

const audit = async (page: Page, info: Parameters<typeof expectLayout>[1], name: string, scope: string) => {
  if (!process.env.LAYOUT_AUDIT) return
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await expectLayout(page, info, `${name}-${colorScheme}`, { scope })
  }
  await page.emulateMedia({ colorScheme: "light" })
}

for (const width of [1440, 390])
  test(`files of any type are attached, saved in Files and sent by path at ${width}px`, async ({ page }, info) => {
    test.setTimeout(180_000)
    const phone = width === 390
    await page.setViewportSize({ width, height: phone ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const files = filesOf(page.request, server().url)
    await files.clear()
    await files.put("/files/outline.md", "# Synthetic outline")
    const workshop = await admin((api) => api.CreateWorkshop({ title: `Attach ${width}` }))
    await page.goto(`${server().url}/chats/${workshop.id}`)
    const composer = page.getByTestId("composer")
    await expect(composer).toBeVisible()

    // The paperclip keeps unsent files in the composer.
    const clip = page.getByRole("button", { name: "Attach", exact: true })
    await expect(clip).toBeEnabled()
    await page.getByLabel("Choose files").setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Synthetic notes for the assistant.")
    })
    const attached = page.getByRole("list", { name: "Attachments" })
    await expect(attached.getByRole("button", { name: "Open notes.txt" })).toBeVisible()
    await expect.soft(page.getByText("Saved in /files/Attachments.")).toHaveCount(0, { timeout: 1000 })
    expect.soft(await files.has("/files/Attachments/notes.txt")).toBe(false)
    await page.getByLabel("Choose files").setInputFiles({
      name: "discard.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Synthetic draft to remove.")
    })
    await expect(attached.getByRole("button", { name: "Open discard.txt" })).toBeVisible()
    await attached.getByRole("button", { name: "Remove discard.txt" }).press("Enter")
    await expect(attached.getByRole("button", { name: "Open discard.txt" })).toHaveCount(0)
    await page.reload()
    await expect(attached.getByRole("button", { name: "Open notes.txt" })).toBeVisible()
    await expect(attached.getByRole("button", { name: "Open discard.txt" })).toHaveCount(0)
    expect.soft(await files.has("/files/Attachments/discard.txt")).toBe(false)

    // The Files tab attaches a file as it is.
    const panel = await openPanel(page, "Files")
    const row = panel.locator('[data-file-row="outline.md"]')
    await row.getByRole("button", { name: "Actions for outline.md" }).click()
    await page.getByRole("menuitem", { name: "Attach to message" }).click()
    if (phone) await page.keyboard.press("Escape")
    await expect(attached.getByRole("button", { name: "Open outline.md" })).toBeVisible()
    await attached.getByRole("button", { name: "Remove outline.md" }).press("Enter")
    await expect(attached.getByRole("button", { name: "Open outline.md" })).toHaveCount(0)
    expect(await files.text("/files/outline.md")).toBe("# Synthetic outline")
    await composer.evaluate((target) => {
      const data = new DataTransfer()
      data.setData("application/x-rp-file-path", "/files/outline.md")
      target.dispatchEvent(
        new DragEvent("drop", { dataTransfer: data, bubbles: true, composed: true, cancelable: true })
      )
    })
    await expect(attached.getByRole("button", { name: "Open outline.md" })).toBeVisible()
    expect(await files.has("/files/Attachments/outline.md")).toBe(false)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await audit(page, info, `attachments-composer-${width}`, '[aria-label="Image attachments"]')

    // Sent: the message lists them; the model was told their paths.
    await page.getByLabel("Message", { exact: true }).fill("Read my notes.")
    await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
    await expect(page.getByRole("article").filter({ hasText: "I can see notes.txt and outline.md." })).toBeVisible({
      timeout: 60_000
    })
    const sent = page.getByRole("article").filter({ hasText: "Read my notes." }).last()
    const listed = sent.getByRole("list", { name: "Message files" })
    await expect(attached).toHaveCount(0)
    expect(await files.text("/files/Attachments/notes.txt")).toBe("Synthetic notes for the assistant.")
    await audit(page, info, `attachments-message-${width}`, "article[data-slot]")

    // A file opens its copy as sent in the viewer for its type (§8.2), read-only, with Download.
    await files.put("/files/Attachments/notes.txt", "Changed after sending.")
    await listed.getByRole("button", { name: "Open notes.txt" }).click()
    const viewer = page.getByRole("dialog", { name: "notes.txt" })
    await expect(viewer.getByRole("textbox", { name: "Contents of notes.txt" })).toHaveText(
      "Synthetic notes for the assistant."
    )
    await expect(viewer.getByRole("textbox", { name: "Contents of notes.txt" })).toHaveAttribute(
      "aria-readonly",
      "true"
    )
    const download = page.waitForEvent("download")
    await viewer.getByRole("button", { name: "Download" }).click()
    expect((await download).suggestedFilename()).toBe("notes.txt")
    await audit(page, info, `attachments-viewer-${width}`, '[role="dialog"]')
    await viewer.getByRole("button", { name: "Close" }).click()

    // Show in Files opens where it is now.
    await listed.getByRole("link", { name: "Show notes.txt in Files" }).click()
    await expect(page).toHaveURL(/\/files\?path=%2Ffiles%2FAttachments&file=notes\.txt(&|$)/)
  })
