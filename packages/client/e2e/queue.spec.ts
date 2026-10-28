// The conflict must stay queued while both tabs edit, whatever the host's load.
import { expect, type Page, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

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
  await page.goto(`${server().url}/chats`)
  await page.getByLabel("Title of the new chat").fill("Queue conflict")
  await page.getByRole("button", { name: "New chat" }).click()
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
