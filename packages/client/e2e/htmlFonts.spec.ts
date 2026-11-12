// Only synthetic rectangle glyphs, through the real renderer and production CSP.
import { expect, test } from "@playwright/test"
import type { SendResult } from "@rp/shared/chatApi.ts"
import type { SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { NARROW_WOFF2, WIDE_WOFF2 } from "../test/fixtures/cardFonts.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

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
            content: `<style>@font-face{font-family:Inter;src:url("${font}")} .glyph{font:40px Inter;display:inline-block}</style><span class="glyph" data-label="Card ${index}">AAAA</span>`
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
