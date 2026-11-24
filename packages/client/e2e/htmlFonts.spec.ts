// Only synthetic rectangle glyphs, through the real renderer and production CSP.
import { expect, test } from "@playwright/test"
import type { SendResult } from "@dreamspan/shared/chatApi.ts"
import type { SlotId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { NARROW_WOFF2, WIDE_WOFF2 } from "../test/fixtures/cardFonts.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

test("two panes keep different versions of the same slot's font private", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const formatted = (font: string, label: string) =>
    `<style>@font-face{font-family:Card;src:url("${font}")}.glyph{font:40px Card;display:inline-block}</style><span class="glyph" data-label="${label}">AAAA</span>`
  const { chat, fork } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Synthetic split fonts" })
      const sent = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        reply: false,
        content: formatted(NARROW_WOFF2, "Narrow")
      })
      if (sent._tag !== "Posted") throw new Error("Synthetic send queued")
      const { fork } = yield* api.CreateFork({
        chatId: chat.id,
        fromForkId: chat.currentForkId!,
        atSlotId: sent.entry.slotId
      })
      const path = yield* api.ReadPath({
        chatId: chat.id,
        forkId: fork.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 1
      })
      const entry = path.entries[0]!
      yield* api.EditVersion({
        slotId: entry.slotId,
        forkId: fork.id,
        sourceVersionId: entry.version.id,
        expectedRowVersion: entry.rowVersion,
        content: formatted(WIDE_WOFF2, "Wide")
      })
      return { chat, fork }
    })
  )
  await page.goto(`${server().url}/chats/${chat.id}?fork=${chat.currentForkId}`)
  const panes = page.locator("[data-frame]")
  await expect(panes.first().locator('.custom-glyph[data-label="Narrow"]')).toBeVisible()
  await page.getByRole("button", { name: "Split right", exact: true }).click()
  const right = panes.nth(1)
  await right.getByRole("button", { name: /^Branch:.*switch branch$/ }).click()
  await page.getByRole("dialog", { name: "Branches of this chat" }).locator(`[data-fork="${fork.id}"] a`).click()
  const narrow = panes.first().locator('.custom-glyph[data-label="Narrow"]')
  const wide = right.locator('.custom-glyph[data-label="Wide"]')
  await expect(narrow).toBeVisible()
  await expect(wide).toBeVisible()
  const width = (node: Element) => node.getBoundingClientRect().width
  await expect.poll(() => narrow.evaluate(width)).toBeCloseTo(64, 0)
  await expect.poll(() => wide.evaluate(width)).toBeCloseTo(144, 0)
})

for (const prefixOnly of [false, true]) {
  test(`embedded fonts render without network requests and stay in their own message (${prefixOnly ? "prefix" : "scope"})`, async ({
    page
  }) => {
    if (prefixOnly) await page.addInitScript(() => Reflect.deleteProperty(window, "CSSScopeRule"))
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateChat({ title: "Synthetic fonts" })
        yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
        let parentSlotId: SlotId | null = null
        for (const [index, font] of [NARROW_WOFF2, WIDE_WOFF2].entries()) {
          const sent: SendResult = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId,
            branch: false,
            reply: false,
            content: `<style>@font-face{font-family:Inter;src:url("${font}")} .glyph{font:80px/2 Inter;font-size:40px;line-height:48px;display:inline-block}</style><span class="glyph" data-label="Card ${index}">AAAA</span>`
          })
          if (sent._tag !== "Posted") throw new Error("Synthetic send queued")
          parentSlotId = sent.entry.slotId
        }
        return chat
      })
    )
    const fontRequests: string[] = []
    page.on("request", (request) => {
      if (request.resourceType() === "font") fontRequests.push(request.url())
    })
    await page.goto(`${server().url}/chats/${chat.id}`)
    await expect(page.locator(".custom-glyph")).toHaveCount(2)
    for (const glyph of await page.locator(".custom-glyph").all()) {
      await expect(glyph).toHaveCSS("font-size", "40px")
      await expect(glyph).toHaveCSS("line-height", "48px")
    }
    await expect
      .poll(() =>
        page.evaluate(async () => {
          await document.fonts.ready
          return Array.from(document.fonts).filter((font) => font.status === "loaded").length
        })
      )
      .toBe(2)
    const widths = await page
      .locator(".custom-glyph")
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width))
    expect(widths[0]).toBeCloseTo(64, 0)
    expect(widths[1]).toBeCloseTo(144, 0)
    expect(fontRequests).toEqual([])
    expect(await page.evaluate(() => Array.from(document.fonts, (font) => font.family))).not.toContain("Inter")
  })

  test(`plain attr stays literal text inside its message and cannot become a resource (${prefixOnly ? "prefix" : "scope"})`, async ({
    page
  }) => {
    if (prefixOnly) await page.addInitScript(() => Reflect.deleteProperty(window, "CSSScopeRule"))
    const probes: string[] = []
    page.on("request", (request) => {
      if (request.url().includes("attr-probe")) probes.push(request.url())
    })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateChat({ title: "Synthetic generated text" })
        yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
        yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          reply: false,
          content: [
            "<style>.label::before{content:attr(data-label)}.label::after{content:attr(title)}",
            ".label{background:image-set(attr(data-label));cursor:attr(data-label);--steal:attr(title)}",
            ".label::after{content:attr(data-label type(<url>))}.label::after{content:attr(data-label, url(/attr-probe))}",
            "[data-source-map]::before{content:attr(data-source-map)}",
            '</style><div class="label" title="Own title" data-label="url(https://example.com/attr-probe)">Own text</div>'
          ].join("\n")
        })
        return chat
      })
    )
    await page.goto(`${server().url}/chats/${chat.id}`)
    const label = page.locator(".custom-label")
    await expect(label).toBeVisible()
    await expect
      .poll(() => label.evaluate((node) => getComputedStyle(node, "::before").content))
      .toBe('"url(https://example.com/attr-probe)"')
    expect(await label.evaluate((node) => getComputedStyle(node, "::after").content)).toBe('"Own title"')
    await expect(label).toHaveCSS("background-image", "none")
    await page.evaluate(() => {
      document.querySelector(".message-html")!.setAttribute("title", "App scope secret")
      const outside = document.createElement("div")
      outside.className = "custom-label"
      outside.title = "Outside secret"
      outside.dataset.label = "Outside label"
      document.querySelector(".message-html")!.after(outside)
    })
    const results = await page
      .locator(".custom-label")
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node, "::before").content))
    expect(results).toEqual(['"url(https://example.com/attr-probe)"', "none"])
    expect(probes).toEqual([])
  })
}
