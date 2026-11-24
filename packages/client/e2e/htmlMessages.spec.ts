// HTML in messages (spec/HTML-MESSAGES.md §3.2), in the built app under its CSP: a synthetic
// card's greeting with inline HTML and a `<style>` renders styled, a `position: fixed` box stays
// inside the message, remote images are blocked with a note, and the viewer's switch shows the
// markup as text instead.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { gotoWithLayout } from "./support/workbench.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "10000", FAKE_GENERATOR_TOKENS: "10" })

/** A 1×1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

const greeting = [
  "<style>",
  ".status { color: rgb(180, 20, 20); border: 2px solid rgb(180, 20, 20); padding: 8px; border-radius: 6px }",
  ".pin { position: fixed; top: 0; right: 0; width: 24px; height: 24px; background: rgb(180, 20, 20) }",
  "@import url(https://example.com/a.css);",
  "</style>",
  '<div class="status" id="hp">HP 12/20 <b>Day 3</b></div>',
  // The card's badge covers its own box on purpose: the audit lets that one overlap.
  '<div class="pin" data-layout-overlay="a card badge over its own message"></div>',
  "",
  'Mira opens the door. <a href="#hp">Status</a>',
  "",
  `<img src="data:image/png;base64,${PNG}" alt="A dot" width="8" height="8"> <img src="https://example.com/map.png" alt="A map">`
].join("\n")

const importCard = async (page: Page, name: string) => {
  const response = await page.request.post(`${server().url}/library/import?name=fixture.json`, {
    data: Buffer.from(
      JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data: { name, first_mes: greeting } })
    ),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
}

for (const mode of ["scope", "prefix"] as const) {
  test(`message styles stay in their workbench view (${mode})`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 })
    if (mode === "prefix") await page.addInitScript(() => Reflect.deleteProperty(window, "CSSScopeRule"))
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const { left, right } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const left = yield* api.CreateChat({ title: "Styled chat" })
        const right = yield* api.CreateChat({ title: "Unstyled chat" })
        const first = yield* api.SendMessage({
          chatId: left.id,
          parentSlotId: null,
          branch: false,
          reply: false,
          content: "<style>.stat { border-top: 3px solid }</style>"
        })
        if (first._tag !== "Posted") throw new Error("Synthetic send queued")
        for (const [chatId, parentSlotId, label] of [
          [left.id, first.entry.slotId, "Same chat"],
          [right.id, null, "Other chat"]
        ] as const)
          yield* api.SendMessage({
            chatId,
            parentSlotId,
            branch: false,
            reply: false,
            content: `<div class="stat">${label}</div>`
          })
        return { left, right }
      })
    )
    await gotoWithLayout(page, server().url, `/chats/${left.id}`, ["r", [1, 1], [0, "="], [0, `/chats/${right.id}`]])
    const stats = page.locator("[data-frame] .custom-stat")
    await expect(stats.filter({ hasText: "Same chat" })).toHaveCSS("border-top-width", "3px")
    await expect(stats.filter({ hasText: "Other chat" })).toHaveCSS("border-top-width", "0px")
  })
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a greeting's HTML and styles at ${width} (${theme})`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      const violations: string[] = []
      page.on("console", (message) => {
        if (message.text().includes("Content Security Policy")) violations.push(message.text())
      })
      const requests: string[] = []
      page.on("request", (request) => {
        if (request.url().includes("example.com")) requests.push(request.url())
      })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const name = `Mira ${width} ${theme}`
      await importCard(page, name)
      await page.goto(`${server().url}/library`)
      await page.getByRole("link", { name: `Start a chat with ${name}`, exact: true }).click()
      const article = page.getByRole("article", { name: "Reply", exact: true })
      const body = article.locator(".markdown")
      const status = body.locator(".custom-status")
      await expect(status).toHaveText("HP 12/20 Day 3")
      // The card's style applies through the chat's constructed stylesheet.
      await expect(status).toHaveCSS("color", "rgb(180, 20, 20)")
      await expect(status).toHaveCSS("border-top-width", "2px")
      await expect(status).toHaveAttribute("id", "user-content-hp")
      await expect(body.getByRole("link", { name: "Status" })).toHaveAttribute("href", "#user-content-hp")
      // Fixed positioning stays inside the message body.
      const pin = await body.locator(".custom-pin").boundingBox()
      const box = await body.boundingBox()
      expect(pin).not.toBeNull()
      expect(pin!.x).toBeGreaterThanOrEqual(box!.x - 1)
      expect(pin!.y).toBeGreaterThanOrEqual(box!.y - 1)
      expect(pin!.x + pin!.width).toBeLessThanOrEqual(box!.x + box!.width + 1)
      expect(pin!.y + pin!.height).toBeLessThanOrEqual(box!.y + box!.height + 1)
      // data: images load; the remote one is blocked, with the note under the message.
      await expect(body.getByRole("img", { name: "A dot" })).toBeVisible()
      await expect(article.getByRole("note")).toContainText("Images from other sites are blocked.")
      expect(requests).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await expectLayout(page, info, `html-greeting-${width}-${theme}`, {
        scope: 'article[aria-label="Reply"]'
      })
      await page.screenshot({ path: info.outputPath(`html-greeting-${width}-${theme}.png`) })

      // Off, the markup shows as text, and the card's style goes.
      await page.goto(`${server().url}/settings/interface`)
      const toggle = page.getByRole("switch", { name: /^Show HTML as formatting/ })
      await expect(toggle).toBeChecked()
      await toggle.click()
      await expect(toggle).not.toBeChecked()
      await page.goBack()
      await expect(article.locator(".markdown")).toContainText('<div class="status" id="hp">')
      await expect(article.locator(".custom-status")).toHaveCount(0)
      await page.goto(`${server().url}/settings/interface`)
      await page.getByRole("switch", { name: /^Show HTML as formatting/ }).click()
      expect(violations).toEqual([])
    })
