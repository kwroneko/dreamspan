import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
for (const width of [1440, 390]) {
  test(`group greetings follow pending cast at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const name = `Mira ${width}`
    const second = `Tobin ${width}`
    for (const data of [
      {
        name,
        first_mes: "Mira opens the door.",
        alternate_greetings: ["Mira waves."],
        group_only_greetings: ["Mira welcomes the crew."]
      },
      { name: second, first_mes: "Tobin nods.", group_only_greetings: ["Tobin greets everyone."] }
    ]) {
      const response = await page.request.post(`${server().url}/library/import?name=fixture.json`, {
        data: Buffer.from(JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data })),
        headers: { origin: server().url, "content-type": "application/octet-stream" }
      })
      expect(response.status()).toBe(200)
    }
    await page.goto(`${server().url}/library`)
    await page.getByRole("link", { name: `Start a chat with ${name}`, exact: true }).click()
    const greeting = page.getByRole("article", { name: `Greeting from ${name}`, exact: true })
    const next = greeting.getByRole("button", { name: `Next greeting from ${name}` })
    await next.click()
    await expect(greeting).toContainText("Mira waves.")
    await expect(next).toBeDisabled()
    const add = async () => {
      await page.getByLabel("Add character", { exact: true }).click()
      await page.getByRole("option", { name: second, exact: true }).click()
      await expect(page.getByRole("article", { name: `Greeting from ${second}`, exact: true })).toBeVisible()
    }
    await add()
    // The ordinary alternate stays selected; both cards now offer their group greetings.
    await expect(greeting).toContainText("Mira waves.")
    await next.click()
    await expect(greeting).toContainText("Mira welcomes the crew.")
    await expect(greeting).toContainText("group greeting")
    const secondGreeting = page.getByRole("article", { name: `Greeting from ${second}`, exact: true })
    await secondGreeting.getByRole("button", { name: `Next greeting from ${second}` }).click()
    await expect(secondGreeting).toContainText("Tobin greets everyone.")
    if (process.env.SCREENSHOT_DIR)
      await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `group-${width}.png`) })
    await page.getByRole("button", { name: `Remove ${second} from pending cast` }).click()
    await expect(greeting).toContainText("Mira opens the door.")
    await expect(page.getByRole("status")).toContainText("selected group greeting is no longer available")
    await expect(page.getByText("group greeting", { exact: true })).toHaveCount(0)
    if (process.env.SCREENSHOT_DIR)
      await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `fallback-${width}.png`) })
    await next.click()
    await expect(next).toBeDisabled()
    await add()
    await next.click()
    await expect(greeting).toContainText("Mira welcomes the crew.")
    await page.getByLabel("Message", { exact: true }).fill("Hello crew.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(page).toHaveURL(/\/chats\/[^/?]+$/)
    await expect(
      page.getByRole("article", { name: "Reply", exact: true }).filter({ hasText: "Mira welcomes the crew." })
    ).toBeVisible()
  })
}
