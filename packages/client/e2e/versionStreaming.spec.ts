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
    const versions = reply.getByRole("group", { name: "Versions", exact: true })
    await versions.getByRole("button", { name: "Generate another version", exact: true }).click()
    await expect(reply.getByText("generating", { exact: true })).toHaveCount(1)
    await versions.getByRole("button", { name: /choose a version/ }).click()
    const picker = page.getByRole("dialog", { name: "Versions of message #2", exact: true })
    await picker.getByRole("button", { name: "Compare", exact: true }).click()
    await picker.getByRole("checkbox", { name: "Compare version 1", exact: true }).click()
    await picker.getByRole("checkbox", { name: "Compare version 2", exact: true }).click()
    const compare = page.getByRole("dialog", { name: "Version 1 and version 2", exact: true })
    const current = compare.getByRole("region", { name: "Version 2", exact: true })
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
