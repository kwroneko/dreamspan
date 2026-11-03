// Account-owned explanations and the snippet's corner marker, with synthetic text only.
import { mkdirSync } from "node:fs"
import { Effect } from "effect"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { openPanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)
const targetText = 'This snippet is currently the default destination for "Send text to snippet" actions.'

test("explanation follows the account and the passive dot follows the target without moving header controls", async ({
  page,
  context
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  const chat = await withCookie(server(), cookie, (api) =>
    Effect.gen(function* () {
      yield* api.SetDisplayPrefs({ prefs: { dismissedInfo: { "snippets.intro": false } } })
      const chat = yield* api.CreateChat({ title: "Corner markers" })
      for (const title of ["Alpha", "Bravo"])
        yield* api.CreateSnippet({ chatId: chat.id, title, content: `${title} notes.` })
      return chat
    })
  )
  const url = `${server().url}/chats/${chat.id}`
  await page.goto(url)
  const panel = await openPanel(page, "Snippets")
  const hide = panel.getByRole("button", { name: "Hide this explanation" })
  await expect(hide).toBeVisible()
  await expect(panel.getByRole("button", { name: "About Search snippets" })).toHaveCount(0)
  const explanation = await hide.locator("..").locator("p").innerText()
  expect(explanation).toContain("marked with a dot in its corner")
  const other = await context.newPage()
  await other.goto(url)
  const otherPanel = await openPanel(other, "Snippets")
  await expect(otherPanel.getByRole("button", { name: "Hide this explanation" })).toBeVisible()
  await hide.click()
  await expect(hide).toHaveCount(0)
  await expect(otherPanel.getByRole("button", { name: "Hide this explanation" })).toHaveCount(0)
  await expect(otherPanel.getByRole("button", { name: "About Search snippets" })).toBeVisible()
  await page.reload()
  const restored = page.getByRole("tabpanel", { name: "Snippets" })
  await expect(restored.getByRole("button", { name: "Hide this explanation" })).toHaveCount(0)
  await restored.getByRole("button", { name: "About Search snippets" }).click()
  await expect(page.getByText(explanation, { exact: true }).last()).toBeVisible()
  await page.mouse.move(0, 0)
  const alpha = restored.getByRole("region", { name: "Snippet Alpha", exact: true })
  const bravo = restored.getByRole("region", { name: "Snippet Bravo", exact: true })
  await alpha.getByRole("textbox", { name: "Text of Alpha" }).click()
  const copy = alpha.getByRole("button", { name: "Copy Alpha", exact: true })
  const before = await copy.boundingBox()
  const dot = alpha.locator("[data-snippet-target]")
  await expect(dot).toBeVisible()
  const cardBox = (await alpha.boundingBox())!
  const dotBox = (await dot.boundingBox())!
  expect(Math.abs(dotBox.x + dotBox.width / 2 - cardBox.x)).toBeLessThanOrEqual(2)
  expect(Math.abs(dotBox.y + dotBox.height / 2 - cardBox.y)).toBeLessThanOrEqual(2)
  expect(dotBox.width).toBeGreaterThanOrEqual(10)
  expect(dotBox.width).toBeLessThanOrEqual(12)
  expect(await dot.evaluate((el) => getComputedStyle(el).cursor)).toBe("default")
  expect(await dot.evaluate((el) => (el as HTMLElement).tabIndex)).toBe(-1)
  await expect(dot).not.toHaveAttribute("tabindex")
  await expect(alpha).toHaveAttribute("aria-description", targetText)
  await dot.hover()
  await expect(page.getByText(targetText, { exact: true }).last()).toBeVisible()
  await bravo.getByRole("textbox", { name: "Text of Bravo" }).click()
  await expect(dot).toHaveCount(0)
  await expect(bravo.locator("[data-snippet-target]")).toBeVisible()
  expect(await copy.boundingBox()).toEqual(before)
  await expect(alpha).not.toHaveAttribute("aria-description")
  const shots = process.env.SCREENSHOT_DIR
  if (shots) {
    mkdirSync(shots, { recursive: true })
    await restored.screenshot({ path: join(shots, "snippets-dismissed.png") })
  }
  await other.close()
})
