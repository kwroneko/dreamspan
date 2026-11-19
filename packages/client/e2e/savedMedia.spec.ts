// Saved card media (spec/SAVED-MEDIA.md): a card imported on the Import page asks about its new
// site, its media is saved on the server (FAKE_SAVED_MEDIA: a synthetic file, no download), and
// viewing its chat makes no request to any other site, with media from other sites blocked.
// Saved video (§3.4) plays from this app.
import { expect, test } from "@playwright/test"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`saved card media at ${width} (${theme})`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.SetExternalMedia({ target: { _tag: "Default" }, allow: false })
      )
      const name = `Saved ${width} ${theme}`
      const host = `pics-${width}-${theme}.invalid`
      const card = {
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: {
          name,
          first_mes:
            `A saved map.\n\n<img class="map" alt="Saved map" src="https://${host}/map.png" width="80" height="80">` +
            '<style>.tile{background-image:url("https://cardex.zip/i/tile.png");width:40px;height:40px}</style><div class="tile"></div>' +
            '\n\n<video class="clip" width="64" height="64"><source src="https://cardex.zip/i/clip.webm" type="video/webm"></video>'
        }
      }
      const outside: string[] = []
      page.on("request", (request) => {
        if (new URL(request.url()).origin !== server().url) outside.push(request.url())
      })

      await page.goto(`${server().url}/import`)
      await page.getByLabel("Choose files, or drop them here").setInputFiles({
        name: "saved.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(card))
      })
      // cardex.zip is approved from the start; the card's other site asks.
      const dialog = page.getByRole("dialog", { name: "Save media from new sites?" })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByText(host, { exact: true })).toBeVisible()
      await expect(dialog.getByText("1 image", { exact: true })).toBeVisible()
      await expect(dialog.getByText("cardex.zip", { exact: true })).toHaveCount(0)
      await expectLayout(page, info, `saved-media-dialog-${width}-${theme}`, { scope: '[role="dialog"]' })
      await dialog.getByRole("combobox", { name: `What to do with ${host}` }).click()
      await page.getByRole("option", { name: "Approve", exact: true }).click()
      await dialog.getByRole("button", { name: "Apply", exact: true }).click()
      await expect(dialog).toHaveCount(0)

      const cards = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListLibrary({ kind: "card" }))
      const ref = cards.find((entry) => entry.label === name)!
      await expect
        .poll(
          async () =>
            (await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.GetSavedMediaStatus({ refId: ref.id })))
              .saved
        )
        .toBe(3)
      const started = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.StartChat({
          cards: [ref.entityId as EntityId],
          persona: null,
          greeting: 0,
          first: { _tag: "Send", content: "Show me.", speakerEntityId: null }
        })
      )
      await page.goto(`${server().url}/chats/${started.chat.id}`)
      const article = page.locator("article", { hasText: "A saved map." })
      const map = article.locator("img.custom-map")
      await expect(map).toBeVisible()
      await expect
        .poll(() => map.evaluate((image) => new URL((image as HTMLImageElement).currentSrc).pathname))
        .toMatch(/^\/media\/saved\//)
      await expect.poll(() => map.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1)
      await expect
        .poll(() => article.locator(".custom-tile").evaluate((tile) => getComputedStyle(tile).backgroundImage))
        .toContain("/media/saved/")
      // Saved video plays from this app: its source is the saved file, and the player reads it.
      const clip = article.locator("video.custom-clip")
      await expect(clip).toBeVisible()
      await expect(clip).toHaveAttribute("controls", "")
      await expect
        .poll(() => clip.evaluate((video) => new URL((video as HTMLVideoElement).currentSrc).pathname))
        .toMatch(/^\/media\/saved\//)
      await expect.poll(() => clip.evaluate((video) => (video as HTMLVideoElement).readyState)).toBeGreaterThan(0)
      await expect.poll(() => clip.evaluate((video) => (video as HTMLVideoElement).videoWidth)).toBe(16)
      // Saved, so nothing is blocked, and nothing went anywhere but this app.
      await expect(article.getByText("Images from other sites are blocked.", { exact: true })).toHaveCount(0)
      await expectLayout(page, info, `saved-media-chat-${width}-${theme}`, { scope: "[data-testid=messages]" })

      await page.goto(`${server().url}/library/${ref.id}`)
      await page.getByRole("tab", { name: "Extra", exact: true }).click()
      const section = page.locator("section", { has: page.getByRole("heading", { name: "Saved media", exact: true }) })
      await expect(section.getByText("3 media files saved here", { exact: true })).toBeVisible()
      await expectLayout(page, info, `saved-media-editor-${width}-${theme}`, { scope: "main" })

      await page.goto(`${server().url}/settings/media-sites`)
      await expect(page.getByText("cardex.zip", { exact: true })).toBeVisible()
      await expect(page.getByText(host, { exact: true })).toBeVisible()
      await expectLayout(page, info, `saved-media-sites-${width}-${theme}`, { scope: "main" })
      expect(outside).toEqual([])
    })
