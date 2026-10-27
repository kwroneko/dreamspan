// The built app under its Content-Security-Policy (server.ts): the header is on the page,
// and every screen, a streamed reply with Markdown, code, a table, raw HTML and an image
// among it, runs without a single violation.
import { expect, type Page, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

/** A 1×1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "120" })

/** Violations, from the moment the page loads: the event, and the console's report of it. */
const watchViolations = async (page: Page) => {
  const violations: Array<string> = []
  await page.exposeFunction("__cspViolation", (text: string) => violations.push(text))
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) =>
      (window as unknown as { __cspViolation: (text: string) => void }).__cspViolation(
        `${event.violatedDirective} ${event.blockedURI}`
      )
    )
  })
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text())
  })
  return violations
}

test("every screen runs under the Content-Security-Policy", async ({ page }) => {
  const violations = await watchViolations(page)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const response = await page.goto(`${server().url}/chats`)
  const csp = response!.headers()["content-security-policy"]!
  expect(csp).toContain("script-src 'self'")
  expect(csp).toContain(`connect-src 'self' ws://127.0.0.1:${server().port}`)

  await page.getByLabel("Title of the new chat").fill("Lighthouse")
  await page.getByRole("button", { name: "New chat" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Lighthouse" })).toBeVisible()
  const message = [
    "The keeper's *log*, with a [chart][c]:",
    "",
    "| Night | Ships |",
    "| --- | --- |",
    "| 1 | 3 |",
    "",
    "```js",
    "const lamp = 'lit'",
    "```",
    "",
    '<div style="color: red" onclick="alert(1)">raw <b>HTML</b></div><script>alert(1)</script>',
    "",
    "![a gull](https://example.com/gull.png)",
    "",
    "[c]: https://example.com/chart"
  ].join("\n")
  await page.getByLabel("Message", { exact: true }).fill(message)
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByRole("article", { name: "Your message" }).locator("table")).toBeVisible()
  await expect(page.getByRole("link", { name: "chart" })).toHaveAttribute("href", "https://example.com/chart")
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
  await expect(page.getByRole("article", { name: "Reply" })).toHaveCount(1)

  // A select's list: Base UI would add an inline <style> for its scrollbar.
  await page.goto(`${server().url}/settings/users`)
  await page.getByRole("button", { name: "New user" }).click()
  await page.getByLabel("Role").click()
  await expect(page.getByRole("option").first()).toBeVisible()
  await page.keyboard.press("Escape")

  for (const path of [
    "/",
    "/chats",
    "/library",
    "/import",
    "/import/st",
    "/settings",
    "/settings/account",
    "/settings/users",
    "/settings/notifications",
    "/settings/status",
    "/bin"
  ]) {
    await page.goto(`${server().url}${path}`)
    await expect(page.getByRole("main")).toBeVisible()
    await page.waitForLoadState("networkidle")
  }
  // The card editor, with its avatar from /library/media and its search in a worker.
  await page.goto(`${server().url}/library`)
  await page.getByRole("button", { name: "New card" }).click()
  await page.getByRole("textbox", { name: "Display name", exact: true }).fill("Wren")
  await page.getByRole("button", { name: "Create" }).click()
  await page.getByLabel("Choose an avatar, or drop it here").setInputFiles({
    name: "wren.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG, "base64")
  })
  await expect(page.getByRole("img", { name: "The card's avatar" })).toBeVisible()
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await page.getByRole("textbox", { name: "Find" }).fill("Wren")
  await page.getByRole("dialog").getByRole("button", { name: "Find" }).click()
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText("1 match.")
  // The character grid and the card's page, with its avatar and its definition.
  await page.goto(`${server().url}/`)
  await page.getByRole("main").getByRole("button", { name: "Open Wren", exact: true }).click()
  await expect(page.getByRole("link", { name: "Edit card", exact: true })).toBeVisible()
  expect(violations).toEqual([])
})
