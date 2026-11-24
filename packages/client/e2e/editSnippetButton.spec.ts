// The message editor's snippet button stays in its row (owner, 2026-11-24): selecting text and
// deselecting it moves nothing, the token count included. With nothing selected the button is
// disabled and says, on hover, to select text; with a selection it's enabled.
import { expect, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { replaceEditorText } from "./support/textbox.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "2000", FAKE_GENERATOR_TOKENS: "20" })

const TEXT = "The lamp is lit, and the harbour is quiet tonight."

test("the message editor's snippet button is always there, disabled without a selection", async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats`)
  await page.getByLabel("Title of the new chat").fill("Snippet button")
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  const composer = page.getByLabel("Message", { exact: true })
  const send = page.getByRole("button", { name: "Send", exact: true })
  await expect(async () => {
    await replaceEditorText(composer, TEXT)
    await expect(send).toBeEnabled({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  await send.click()
  const mine = page.getByRole("article", { name: "Your message", exact: true }).filter({ hasText: "The lamp" })
  await expect(mine).toHaveCount(1)
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })

  const slot = await mine.getAttribute("data-slot")
  const article = page.locator(`article[data-slot="${slot}"]`)
  await article.locator(".markdown").getByText("The lamp").dblclick()
  const editor = article.getByRole("textbox", { name: "Message text" })
  await expect(editor).toBeFocused()
  // A double-click selects a word: start from no selection.
  await page.keyboard.press("End")

  const tokens = article.locator("[data-edit-tokens]")
  const button = article.locator('[data-text-action="snippets.send"]')
  const tokensX = async () => (await tokens.boundingBox())!.x
  await expect(button).toHaveCount(1)
  await expect(button).toHaveAttribute("aria-disabled", "true")
  await expect(button).toHaveAccessibleDescription("Select text to add it to a snippet.")
  const x = await tokensX()

  await page.keyboard.press("Shift+Home")
  await expect(button).not.toHaveAttribute("aria-disabled", "true")
  await expect(button).toHaveAccessibleDescription(/selected text/)
  expect(await tokensX()).toBe(x)

  await page.keyboard.press("End")
  await expect(button).toHaveAttribute("aria-disabled", "true")
  expect(await tokensX()).toBe(x)

  // Disabled, it still explains itself on hover.
  await button.hover()
  await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"][data-open]')).toContainText(
    "Select text to add it to a snippet."
  )
})
