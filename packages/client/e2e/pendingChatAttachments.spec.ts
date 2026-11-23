// A chat not made yet attaches as a saved chat does: the same paperclip in the same row, paste
// and drop, the thumbnails under the text; a reload keeps them, and the first send makes the
// chat with them on its first message. Generate leaves them, and they move to the saved chat's
// composer. At 1440 and 390 with the layout audit. Synthetic cards and a drawn image only.
import { expect, type Page, test } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200", FAKE_GENERATOR_TOKENS: "20" })
const chats = () => asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListChats({ limit: 500, before: null }))

/** A small synthetic picture, drawn here. */
const drawing = async (page: Page) =>
  Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = 240
      canvas.height = 300
      const ctx = canvas.getContext("2d")!
      ctx.fillStyle = "#e8f0f6"
      ctx.fillRect(0, 0, 240, 300)
      ctx.fillStyle = "#3a5f7a"
      ctx.beginPath()
      ctx.arc(120, 140, 70, 0, Math.PI * 2)
      ctx.fill()
      return canvas.toDataURL("image/png").split(",")[1]!
    }),
    "base64"
  )

/** Pastes into the box, or drops on the message column, a file as the browser hands it over. */
const transfer = (page: Page, kind: "paste" | "drop", name: string, base64: string) =>
  page.evaluate(
    ({ kind, name, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], name, { type: "image/png" }))
      const target =
        kind === "paste"
          ? document.querySelector('[data-testid="composer"]')!
          : document.querySelector("[data-chat-main] .overflow-y-auto")!
      if (kind === "drop")
        target.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }))
      target.dispatchEvent(
        kind === "paste"
          ? new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
          : new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true })
      )
    },
    { kind, name, base64 }
  )

const attached = (page: Page) => page.getByRole("list", { name: "Attached images" })

for (const width of [1440, 390]) {
  test(`a new chat attaches, keeps attachments over a reload, and sends them at ${width}`, async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const name = `Harbor keeper ${width}`
    const card = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.CreateCard({ label: name, name }))
    const before = (await chats()).length
    await page.goto(`${server().url}/cards/${card.entityId}/chat`)
    const box = page.getByLabel("Message", { exact: true })
    await expect(box).toBeVisible({ timeout: 30_000 })

    // The paperclip sits in the box's control row, as in a saved chat.
    const attach = page.getByRole("button", { name: "Attach images", exact: true })
    await expect(attach).toBeEnabled()
    const buffer = await drawing(page)
    await page.getByLabel("Choose images").setInputFiles({ name: "picked.png", mimeType: "image/png", buffer })
    await expect(attached(page).getByRole("img")).toHaveCount(1)
    await expect(page.getByRole("button", { name: "Remove picked.png" })).toBeVisible()
    // Image-only: Send is ready once it's uploaded.
    await expect(page.getByRole("button", { name: /^Send/ })).toBeEnabled()
    await expectLayout(page, info, `pending-attachments-${width}`)

    // Paste into the box and drop on the chat attach too.
    const base64 = buffer.toString("base64")
    await transfer(page, "paste", "pasted.png", base64)
    await expect(page.getByRole("button", { name: "Remove pasted.png" })).toBeVisible()
    await transfer(page, "drop", "dropped.png", base64)
    await expect(page.getByRole("button", { name: "Remove dropped.png" })).toBeVisible()
    await expect(attached(page).getByRole("img")).toHaveCount(3)
    await box.fill("Here's the harbor.")
    await expect(page.getByRole("button", { name: /^Send/ })).toBeEnabled()

    // A reload keeps them, and still nothing is made.
    await page.waitForTimeout(800)
    await page.reload()
    await expect(attached(page).getByRole("img")).toHaveCount(3, { timeout: 30_000 })
    await expect(box).toHaveValue("Here's the harbor.")
    expect((await chats()).length).toBe(before)
    await expectLayout(page, info, `pending-attachments-reloaded-${width}`)

    // The first send makes the chat, with them on its first message.
    await page.getByRole("button", { name: /^Send/ }).click()
    await expect(page).toHaveURL(/\/chats\/[^/?]+/)
    const sent = page.getByRole("article").filter({ hasText: "Here's the harbor." })
    await expect(sent.getByRole("button", { name: /^View image/ })).toHaveCount(3)
    await expect(attached(page)).toHaveCount(0)
    const chatId = new URL(page.url()).pathname.split("/")[2]!
    const path = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.ReadPath({ chatId: chatId as never, forkId: null, leafSlotId: null, range: { _tag: "Bottom" }, limit: 60 })
    )
    const first = path.entries.find((entry) => entry.version.content === "Here's the harbor.")
    expect(first?.version.images?.map((image) => image.altText)).toEqual(["picked.png", "pasted.png", "dropped.png"])
    expect((await chats()).length).toBe(before + 1)
    await expectLayout(page, info, `pending-attachments-sent-${width}`)
  })
}

test("Generate leaves the attachments, and they move to the saved chat's composer", async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const card = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateCard({ label: "Lighthouse keeper", name: "Lighthouse keeper" })
  )
  await page.goto(`${server().url}/cards/${card.entityId}/chat`)
  await expect(page.getByRole("button", { name: "Attach images", exact: true })).toBeEnabled({ timeout: 30_000 })
  await page
    .getByLabel("Choose images")
    .setInputFiles({ name: "kept.png", mimeType: "image/png", buffer: await drawing(page) })
  await expect(attached(page).getByRole("img")).toHaveCount(1)
  const generate = page.getByRole("button", { name: /^Generate/ })
  await expect(generate).toBeEnabled()
  await generate.click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+/)
  // Attached to the saved chat's draft on the server: it's there without this browser's copy.
  await expect(page.getByRole("button", { name: "Remove kept.png" })).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(800)
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase("dreamspan.message-images")
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      })
  )
  await page.reload()
  await expect(page.getByRole("button", { name: "Remove kept.png" })).toBeVisible({ timeout: 30_000 })
})
