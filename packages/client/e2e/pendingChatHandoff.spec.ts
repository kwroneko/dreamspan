import { test, expect, type Page } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "60", FAKE_GENERATOR_TOKENS: "1200" })
const pendingPlace = (page: Page) => {
  const url = new URL(page.url())
  // The workbench records its tab layout independently of the pending chat.
  url.searchParams.delete("wb")
  return url.href
}

const setup = async (page: Page, title: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const existing = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListCards())
  for (const name of ["Handoff Mira", "Tobias Wren"]) {
    if (existing.some((card) => card.name === name)) continue
    await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
      data: Buffer.from(
        JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name, first_mes: "Welcome." } })
      ),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
  }
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const cards = (yield* api.ListCards()).filter((c) => ["Handoff Mira", "Tobias Wren"].includes(c.name))
      const chat = yield* api.CreateChat({ title })
      for (const entityId of cards.map((c) => c.entityId))
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId } })
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "First turn." })
      return chat
    })
  )
  await page.goto(`${server().url}/groups/${chat.id}/new`)
  // A new chat of the group (DraftChatPage.tsx): each member's greeting, its URL naming it.
  await expect(page.getByRole("article", { name: "Reply", exact: true })).toHaveCount(2)
  await expect(page).toHaveURL(/[?&]draft=/)
  return chat
}

test("a group's pending chat accepts the group's full existing title", async ({ page }) => {
  const title = "An existing group " + "x".repeat(200)
  await page.setViewportSize({ width: 1440, height: 900 })
  await setup(page, title)
  await page.screenshot({ path: test.info().outputPath("desktop-long-group-pending.png") })
  await page.getByLabel("Message", { exact: true }).fill("Please start this group chat.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+(?:\?.*)?$/, { timeout: 5000 })
  const groups = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListChatGroups())
  const group = groups.find((group) => group.name === title)!
  expect(group.chats).toBe(2)
  expect(group.latestChatId).toBe(new URL(page.url()).pathname.split("/").at(-1))
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
  await page.screenshot({ path: test.info().outputPath("phone-long-group-saved.png") })
})

test("a phone shows the full streaming speaker name and Stop", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page, "Lantern Inn")
  const cards = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListCards())
  await page.goto(`${server().url}/cards/${cards.find((c) => c.name === "Tobias Wren")!.entityId}/chat`)
  await page.getByLabel("Message", { exact: true }).fill("Tell a story.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+(?:\?.*)?$/)
  const reply = page.getByRole("article", { name: "Reply", exact: true }).last()
  await expect(reply.getByText("generating", { exact: true })).toBeVisible()
  await expect(reply.getByRole("button", { name: "Stop", exact: true })).toBeInViewport()
  const speaker = reply.locator("header").getByText("Tobias Wren", { exact: true })
  await expect(speaker).toBeVisible()
  expect(await speaker.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath("phone-streaming.png") })
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(speaker).toBeVisible()
  await expect(reply.getByRole("button", { name: "Stop", exact: true })).toBeInViewport()
  await page.screenshot({ path: test.info().outputPath("desktop-streaming.png") })
})

for (const target of ["card", "group"] as const) {
  for (const width of [1440, 390]) {
    test(`${target}: compact composer grows, keeps newlines and sends with Enter at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await setup(page, `Compact composer ${width}`)
      if (target === "card") {
        const cards = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListCards())
        await page.goto(`${server().url}/cards/${cards.find((c) => c.name === "Tobias Wren")!.entityId}/chat`)
        await expect(page).toHaveURL(/[?&]draft=/)
      }
      const composer = page.getByLabel("Message", { exact: true })
      // The composer's own: a greeting's swipe arrow is also named Generate (another swipe).
      const box = page.getByTestId("composer-box")
      const send = box.getByRole("button", { name: "Send", exact: true })
      const generate = box.getByRole("button", { name: /^Generate\b/ })
      await expect(composer).toBeEditable()
      // The chat's own composer (a new chat is a pending chat): empty, its send button asks for
      // a reply, as in any chat; the text on a row of its own, the actions on the control row
      // under it; on a phone, Generate is an icon.
      await expect(generate).toHaveText(width === 390 ? "" : "Generate")
      const empty = (await composer.boundingBox())!
      expect(empty.height).toBeLessThan(45)
      const outline = (await page.getByTestId("composer-box").boundingBox())!
      expect(empty.width).toBeGreaterThan(outline.width * 0.95)
      await composer.fill("x")
      await expect(send.locator("svg")).toBeVisible()
      await composer.fill("")
      for (const control of [generate, page.getByRole("switch", { name: "Guidance", exact: true })]) {
        const box = (await control.boundingBox())!
        expect(box.y).toBeGreaterThanOrEqual(empty.y + empty.height - 1)
        expect(box.y + box.height).toBeLessThanOrEqual(outline.y + outline.height)
        expect(box.x + box.width).toBeLessThanOrEqual(Math.min(width, outline.x + outline.width))
      }
      const pendingUrl = pendingPlace(page)
      await composer.fill("First line")
      await composer.press("Shift+Enter")
      await composer.press("Shift+Enter")
      await composer.press("Shift+Enter")
      await composer.press("Shift+Enter")
      await composer.pressSequentially("Second line")
      await expectTextBox(composer, "First line\n\n\n\nSecond line")
      const sendBox = (await send.boundingBox())!
      expect(sendBox.x + sendBox.width).toBeLessThanOrEqual(Math.min(width, outline.x + outline.width))
      expect((await composer.boundingBox())!.height).toBeGreaterThan(empty.height)
      expect(pendingPlace(page)).toBe(pendingUrl)
      await page.reload()
      await expectTextBox(composer, "First line\n\n\n\nSecond line")
      await send.hover()
      // The tooltip ends with the key that sends, and only that (Base UI gives its popup no tooltip role).
      await expect(page.getByText(/^Send\b.*\. \(Enter\)$/)).toBeVisible()
      await composer.press("Enter")
      await expect(page).toHaveURL(/\/chats\/[^/?]+(?:\?.*)?$/)
      await expect(page.getByRole("article", { name: "Your message", exact: true })).toContainText("First line")
      await expect(page.getByRole("article", { name: "Your message", exact: true }).locator(".markdown")).toContainText(
        "Second line"
      )
    })
  }
}

test("a touch keyboard keeps Enter for a newline; Ctrl+Enter creates the chat", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  try {
    await setup(page, "Touch composer")
    const composer = page.getByLabel("Message", { exact: true })
    const pendingUrl = pendingPlace(page)
    await composer.fill("Touch keyboard")
    await composer.press("Enter")
    await expectTextBox(composer, "Touch keyboard\n")
    expect(pendingPlace(page)).toBe(pendingUrl)
    await composer.press("Control+Enter")
    await expect(page).toHaveURL(/\/chats\/[^/?]+(?:\?.*)?$/)
    await expect(page.getByRole("article", { name: "Your message", exact: true })).toContainText("Touch keyboard")
  } finally {
    await context.close()
  }
})
