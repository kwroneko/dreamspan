import { expect, type Page, test } from "@playwright/test"
import { apiLogin, ADMIN, serverPerFile, withAdmin } from "./support/server.ts"
import { asPage } from "./support/rpc.ts"

// Over plain HTTP on a LAN address the page isn't a secure context, so `crypto.randomUUID`
// is missing. Tests run on localhost, which is secure, so the init script removes it.
const server = serverPerFile(withAdmin)
const insecure = async (page: Page) => {
  await page.addInitScript(() => {
    delete (Crypto.prototype as { randomUUID?: unknown }).randomUUID
  })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
}

test("attaching an image works without crypto.randomUUID", async ({ page }) => {
  await insecure(page)
  // Made before its first message (New chat makes nothing until then): attaching needs a saved chat.
  const chat = await asPage(page, server(), (api) => api.CreateChat({ title: "Insecure context" }))
  await page.goto(`${server().url}/chats/${chat.id}`)
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined")
  await expect(page.getByRole("button", { name: "Attach images", exact: true })).toBeEnabled()
  const png = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = 40
      canvas.height = 30
      const ctx = canvas.getContext("2d")!
      ctx.fillStyle = "#31576a"
      ctx.fillRect(0, 0, 40, 30)
      return canvas.toDataURL("image/png").split(",")[1]!
    }),
    "base64"
  )
  await page.getByLabel("Choose images").setInputFiles({ name: "swatch.png", mimeType: "image/png", buffer: png })
  await expect(page.getByRole("list", { name: "Attached images" }).getByRole("img")).toHaveCount(1)
  await expect(page.getByText("Remove an image or reload to retry.")).toHaveCount(0)
  await page.getByLabel("Message", { exact: true }).fill("A swatch.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("button", { name: "View image 1" })).toBeVisible()
})

test("adding a cost formula works without crypto.randomUUID", async ({ page }) => {
  await insecure(page)
  await page.goto(`${server().url}/settings/costs`)
  await expect(page.getByRole("heading", { level: 1, name: "Costs", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Add formula", exact: true }).click()
  await expect(page.getByLabel("Name", { exact: true }).last()).toHaveValue("New formula")
})
