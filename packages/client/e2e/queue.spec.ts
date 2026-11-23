// The conflict must stay queued while both tabs edit, whatever the host's load.
import { expect, type Page, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { asPage } from "./support/rpc.ts"
import { expectTextBox } from "./support/textbox.ts"

// A reply lasts at least 100 seconds, beyond this test's 60-second deadline. The
// test stops it explicitly; the other chat flows keep their short synthetic replies.
const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "40", FAKE_GENERATOR_TOKENS: "4000" })
const composer = (page: Page) => page.getByLabel("Message", { exact: true })

test("saving a queued message another tab changed meanwhile is a conflict, not an overwrite", async ({
  page,
  context
}) => {
  let heard = false
  page.on("websocket", (socket) =>
    socket.on("framereceived", (frame) => {
      if (String(frame.payload).includes("The other tab's edit.")) heard = true
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  // Made before its first message (New chat makes nothing until then): both tabs open the saved chat.
  const chat = await asPage(page, server(), (api) => api.CreateChat({ title: "Queue conflict" }))
  await page.goto(`${server().url}/chats/${chat.id}`)
  await expect(page.getByRole("heading", { name: "Queue conflict", level: 1 })).toBeVisible()
  const other = await context.newPage()
  await other.goto(page.url())
  await expect(other.getByRole("heading", { name: "Queue conflict", level: 1 })).toBeVisible()

  await composer(page).fill("A pending reply.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByText("generating", { exact: true })).toBeVisible()
  await composer(page).fill("The first words.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  const mine = page.getByRole("list", { name: "Queued messages" })
  await expect(mine).toContainText("The first words.")
  const theirs = other.getByRole("list", { name: "Queued messages" })
  await expect(theirs).toContainText("The first words.")

  await mine.getByRole("button", { name: "Edit" }).click()
  await mine.getByLabel("Queued message").fill("An older draft.")
  if (await theirs.getByRole("button", { name: "Edit", exact: true }).count())
    await theirs.getByRole("button", { name: "Edit", exact: true }).click()
  await theirs.getByLabel("Queued message").fill("The other tab's edit.")
  await theirs.getByRole("button", { name: "Save" }).click()
  await expect(theirs).toContainText("The other tab's edit.")
  // Once this tab has heard of it, its save is refused with theirs shown; its own text stays.
  await expect.poll(() => heard).toBe(true)
  await expect(mine.getByLabel("Queued message")).toHaveValue("An older draft.")
  await mine.getByRole("button", { name: "Save" }).click()
  await expect(mine.getByRole("alert")).toContainText("The other tab's edit.")
  await expect(theirs).toContainText("The other tab's edit.")
  await expect(mine.getByLabel("Queued message")).toHaveValue("An older draft.")
  // Saving again is deliberate: it replaces theirs.
  await mine.getByRole("button", { name: "Save" }).click()
  await expect(mine).toContainText("An older draft.")
  await expect(theirs).toContainText("An older draft.")
  await other.close()
  await page.getByRole("button", { name: "Stop", exact: true }).first().click()
})

for (const width of [1440, 390]) {
  test(`queued image previews and withdrawal preserve durable edits and attachments at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats`)
    await page.getByLabel("Title of the new chat").fill(`Queue image recovery ${width}`)
    await page.getByRole("button", { name: "New chat" }).click()
    await composer(page).fill("Start a long reply.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    // New chat opens the chat not made yet; the first send makes it and moves to its page.
    await expect(page).toHaveURL(/\/chats\/[^/?]+/)
    await expect(page.getByText("generating", { exact: true })).toBeVisible()

    const image = await page.evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 32
      canvas.getContext("2d")!.fillRect(0, 0, 32, 32)
      return canvas.toDataURL("image/png").split(",")[1]!
    })
    await page.getByLabel("Choose images").setInputFiles({
      name: "queued.png",
      mimeType: "image/png",
      buffer: Buffer.from(image, "base64")
    })
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
    await page.getByRole("button", { name: "Send", exact: true }).click()
    const queue = page.getByRole("list", { name: "Queued messages" })
    await expect(queue.getByRole("button", { name: "View image 1" })).toBeVisible()
    await queue.getByRole("button", { name: "Edit", exact: true }).click()
    await queue.getByLabel("Queued message").fill("An image with a durable queued edit.")
    await expect(queue.getByRole("button", { name: "Save", exact: true })).toBeEnabled()
    await queue.getByRole("button", { name: "Save", exact: true }).click()
    await expect(queue).toContainText("An image with a durable queued edit.")
    await page.reload()
    await expect(queue.getByRole("button", { name: "View image 1" })).toBeVisible()
    await queue.getByRole("button", { name: "Withdraw", exact: true }).click()
    await expect(queue).toHaveCount(0)
    await expectTextBox(composer(page), "An image with a durable queued edit.")
    await expect(page.getByRole("list", { name: "Attached images" }).getByRole("img")).toHaveCount(1)
    await page.getByRole("button", { name: "Stop", exact: true }).first().click()
    await page.reload()
    await expectTextBox(composer(page), "An image with a durable queued edit.")
    await expect(page.getByRole("list", { name: "Attached images" }).getByRole("img")).toHaveCount(1)
  })
}
