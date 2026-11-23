// Regression for comparing a streaming swipe: the dialog stays open across completion
// and retains the final saved content and metadata at both widths.
import { expect, test } from "@playwright/test"
import { syntheticMarkdown, tokenize } from "../../server/src/dev/syntheticText.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const seed = 1312
const tokens = 120
const tps = 5
// The requested size is approximate; derive the wait from the actual fixture body.
const completionMs = Math.ceil(tokenize(syntheticMarkdown(seed, tokens)).length / tps) * 1000 + 10_000
const server = serverPerFile({
  ...withAdmin,
  FAKE_GENERATOR_TPS: String(tps),
  FAKE_GENERATOR_TOKENS: String(tokens),
  FAKE_GENERATOR_SEED: String(seed)
})

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 }
]) {
  test(`comparison follows a streaming version through completion at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize(viewport)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats`)
    await page.getByLabel("Title of the new chat").fill(`Streaming comparison ${viewport.width}`)
    await page.getByRole("button", { name: "New chat", exact: true }).click()
    await page.getByLabel("Message", { exact: true }).fill("The lantern swings.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    const reply = page.getByRole("article", { name: "Reply", exact: true, includeHidden: true }).last()
    await expect(reply.getByText("generating", { exact: true })).toHaveCount(1)
    await expect(reply.getByText("generating", { exact: true })).toHaveCount(0, { timeout: completionMs })
    const versions = reply.getByRole("group", { name: "Swipes", exact: true })
    await versions.getByRole("button", { name: "Generate another swipe", exact: true }).click()
    await expect(reply.getByText("generating", { exact: true })).toHaveCount(1)
    await versions.getByRole("button", { name: /choose a swipe/ }).click()
    const picker = page.getByRole("dialog", { name: "Swipes of message #2", exact: true })
    // A word already visible in the live reply must match while it is still streaming.
    await expect.poll(async () => (await reply.locator(".markdown").innerText()).length).toBeGreaterThan(40)
    const word = (await reply.locator(".markdown").innerText()).match(/[a-zA-Z]{4,}/)![0]!
    const find = picker.getByRole("searchbox", { name: "Find in swipes" })
    await find.fill(word)
    await expect(picker.getByRole("button", { name: /^Swipe 2,/ })).toBeVisible()
    await find.fill("")
    await picker.getByRole("button", { name: "Compare", exact: true }).click()
    await picker.getByRole("checkbox", { name: "Compare swipe 1", exact: true }).click()
    await picker.getByRole("checkbox", { name: "Compare swipe 2", exact: true }).click()
    const compare = page.getByRole("dialog", { name: "Swipe 1 and swipe 2", exact: true })
    const current = compare.getByRole("region", { name: "Swipe 2", exact: true })
    await expect(current.getByText("generating", { exact: true })).toHaveCount(1)
    await compare.getByRole("button", { name: "What changed", exact: true }).click()
    await expect(reply.getByText("generating", { exact: true })).toHaveCount(0, { timeout: completionMs })
    // Switching back must show the final text, even though Compare opened on a live version.
    await compare.getByRole("button", { name: "Both texts", exact: true }).click()
    const finalText = (await reply.locator(".markdown").textContent()) ?? ""
    expect(finalText.length).toBeGreaterThan(300)
    await expect(current.locator(".markdown")).toHaveText(finalText)
    await expect(current.getByText("generating", { exact: true })).toHaveCount(0)
  })
}
