// Consent in the existing message note, chat settings, Interface and card editor. Synthetic
// media responses are intercepted at the app route; server tests exercise the actual proxy.
import { expect, test } from "@playwright/test"
import type { EntityId } from "@rp/shared/chat.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64"
)
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`external media consent at ${width} (${theme})`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.SetExternalMedia({ target: { _tag: "Default" }, allow: false })
      )
      const imported = await page.request.post(`${server().url}/library/import?name=media.json`, {
        data: Buffer.from(
          JSON.stringify({
            spec: "chara_card_v3",
            spec_version: "3.0",
            data: {
              name: `Media ${width} ${theme}`,
              first_mes:
                'A synthetic map.\n\n<img class="map" alt="Synthetic map" src="https://media.invalid/map.png" width="80" height="80">\n\n<style>.tile{background-image:url("https://media.invalid/tile.png");width:40px;height:40px}</style><div class="tile"></div>' +
                '<span src="/media/external?url=inert-attribute"></span><style>.literal{--address:"/media/external?url=inert-style";content:\'url("/media/external?url=inert-content")\'}</style><span class="literal"></span>' +
                '<style>:is([data-probe="yes"] *) .tile{background-image:url("https://media.invalid/yes.png")} :is([data-probe="no"] *) .tile{background-image:url("https://media.invalid/no.png")} @media (width:0px){.absent{background:url("https://media.invalid/never.png")}}</style>' +
                "\n\n<div>" +
                Array.from(
                  { length: 80 },
                  (_, i) =>
                    `<img class="gallery" alt="Gallery ${i}" width="8" height="8" src="https://media.invalid/gallery-${i}.png">`
                ).join("") +
                "</div>"
            }
          })
        ),
        headers: { origin: server().url, "content-type": "application/octet-stream" }
      })
      expect(imported.status()).toBe(200)
      const { ref } = ((await imported.json()) as { library: { ref: { id: string; entityId: EntityId } } }).library
      const started = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.StartChat({
          cards: [ref.entityId],
          persona: null,
          greeting: 0,
          first: { _tag: "Send", content: "Map please.", speakerEntityId: null }
        })
      )
      const requests: string[] = []
      const attempts = new Map<string, number>()
      const direct: string[] = []
      page.on("request", (request) => {
        if (new URL(request.url()).hostname === "media.invalid") direct.push(request.url())
      })
      await page.route("**/media/external?**", async (route) => {
        const address = route.request().url()
        requests.push(address)
        const attempt = (attempts.get(address) ?? 0) + 1
        attempts.set(address, attempt)
        if (attempt % 2 === 1) {
          await route.fulfill({ status: 429, headers: { "retry-after": "1", "cache-control": "no-store" } })
          return
        }
        await route.fulfill({
          status: 200,
          body: pixel,
          contentType: "image/png",
          headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "cross-origin-resource-policy": "same-origin",
            "content-disposition": "attachment",
            "content-security-policy": "sandbox; default-src 'none'; frame-ancestors 'none'"
          }
        })
      })
      await page.goto(`${server().url}/chats/${started.chat.id}`)
      const article = page.locator("article", { hasText: "A synthetic map." })
      await expect(article.getByText("Images from other sites are blocked.", { exact: true })).toBeVisible()
      await expect(article.getByRole("button", { name: "Allow for this card", exact: true })).toBeVisible()
      expect(requests).toEqual([])
      await expectLayout(page, info, `external-media-blocked-${width}-${theme}`, { scope: "[data-testid=messages]" })
      await article.getByRole("button", { name: "Allow for this card", exact: true }).click()
      await expect(article.locator("img.custom-map")).toBeVisible()
      await expect
        .poll(() =>
          article
            .locator("img.custom-map")
            .evaluate((image) => (image as HTMLImageElement).currentSrc.startsWith("blob:"))
        )
        .toBe(true)
      await expect
        .poll(() => article.locator("img.custom-map").evaluate((image) => (image as HTMLImageElement).naturalWidth))
        .toBe(1)
      await expect(article.getByText("Images from other sites are blocked.", { exact: true })).toHaveCount(0)
      await expect
        .poll(() =>
          article
            .locator("img.custom-gallery")
            .evaluateAll(
              (images) =>
                images.filter(
                  (image) =>
                    (image as HTMLImageElement).currentSrc.startsWith("blob:") &&
                    (image as HTMLImageElement).naturalWidth === 1
                ).length
            )
        )
        .toBe(80)
      await expect
        .poll(() =>
          requests.some((request) => new URL(request).searchParams.get("url") === "https://media.invalid/tile.png")
        )
        .toBe(true)
      // Both state branches, and a rule that cannot match, fetch before any selector does.
      for (const name of ["yes", "no", "never"])
        await expect
          .poll(() =>
            requests.some((request) => new URL(request).searchParams.get("url") === `https://media.invalid/${name}.png`)
          )
          .toBe(true)
      const addresses = [...new Set(requests)].sort()
      await page.evaluate(async () => {
        document.documentElement.dataset.probe = "yes"
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })
      expect([...new Set(requests)].sort()).toEqual(addresses)
      await expectLayout(page, info, `external-media-allowed-${width}-${theme}`, { scope: "[data-testid=messages]" })
      await page.reload()
      await expect(article.locator("img.custom-map")).toBeVisible()
      await expect
        .poll(() =>
          article
            .locator("img.custom-map")
            .evaluate((image) => (image as HTMLImageElement).currentSrc.startsWith("blob:"))
        )
        .toBe(true)
      await expect
        .poll(() => article.locator("img.custom-map").evaluate((image) => (image as HTMLImageElement).naturalWidth))
        .toBe(1)
      await expect
        .poll(() =>
          article
            .locator("img.custom-gallery")
            .evaluateAll(
              (images) =>
                images.filter(
                  (image) =>
                    (image as HTMLImageElement).currentSrc.startsWith("blob:") &&
                    (image as HTMLImageElement).naturalWidth === 1
                ).length
            )
        )
        .toBe(80)
      expect([...attempts.values()].every((count) => count >= 2)).toBe(true)
      const settings = await openPanel(page, "This chat")
      const chatChoice = settings.getByRole("combobox", { name: "Images from other sites in this chat" })
      await chatChoice.click()
      await page.getByRole("option", { name: "Block", exact: true }).click()
      await expect(article.getByText("Images from other sites are blocked.", { exact: true })).toBeAttached()
      await expectLayout(page, info, `external-media-chat-${width}-${theme}`, {
        scope: '[role="tabpanel"][aria-label="This chat"]'
      })
      await page.reload()
      await expect(
        (await openPanel(page, "This chat")).getByRole("combobox", { name: "Images from other sites in this chat" })
      ).toHaveText("Block")
      const iface = await openPanel(page, "Interface")
      const account = iface.getByRole("switch", { name: "Images from other sites", exact: true })
      await expect(account).not.toBeChecked()
      await account.click()
      await expect(account).toBeChecked()
      await expectLayout(page, info, `external-media-default-${width}-${theme}`, {
        scope: '[role="tabpanel"][aria-label="Interface"]'
      })
      await page.goto(`${server().url}/library/${ref.id}`)
      await page.getByRole("tab", { name: "Extra", exact: true }).click()
      const cardChoice = page.getByRole("combobox", { name: "Images from other sites from this card" })
      await expect(cardChoice).toHaveText("Allow")
      await cardChoice.click()
      await page.getByRole("option", { name: "Block", exact: true }).click()
      await expect(cardChoice).toHaveText("Block")
      await expectLayout(page, info, `external-media-editor-${width}-${theme}`)
      expect(direct).toEqual([])
      expect(requests.some((request) => request.includes("inert-"))).toBe(false)
    })
