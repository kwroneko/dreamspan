// A chat's own picture (audit item 010): chosen, changed and removed from This chat, with Undo,
// and shown for the chat in the chats list and its header in place of its characters' faces.
// Synthetic cards, chats and pixels only.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { hideAppNavigation, showAppNavigation } from "./support/appMenu.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { portraitPng } from "./support/portrait.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, startServer, withAdmin } from "./support/server.ts"

test.setTimeout(180_000)
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`${width} ${theme}: a chat's own picture is set, changed, removed and undone`, async ({ page }, info) => {
      const server = await startServer(withAdmin)
      try {
        const seed = await asUser(server, ADMIN.handle, ADMIN.password, (api) =>
          Effect.gen(function* () {
            const mira = yield* api.CreateCard({ label: "Mira Lantern", name: "Mira Lantern" })
            const tomas = yield* api.CreateCard({ label: "Tomas Reed", name: "Tomas Reed" })
            const start = (cards: ReadonlyArray<typeof mira.entityId>, content: string) =>
              api.StartChat({
                cards: [...cards],
                persona: null,
                greeting: 0,
                first: { _tag: "Send", content, speakerEntityId: null }
              })
            const plain = yield* start([tomas.entityId], "A synthetic walk along the quay.")
            const pictured = yield* start([mira.entityId, tomas.entityId], "A synthetic evening at the lighthouse.")
            return { plain: plain.chat.id, pictured: pictured.chat.id }
          })
        )
        await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.goto(`${server.url}/chats/${seed.pictured}`)
        const tab = await openPanel(page, "This chat")
        const section = tab.getByRole("region", { name: "Chat picture", exact: true })
        const scope = '[role="tabpanel"][aria-label="This chat"]'
        await expect(section.getByText("The characters’ faces", { exact: true })).toBeVisible()
        const choose = section.getByRole("button", { name: "Choose a picture", exact: true })
        await choose.hover()
        await expect(
          page
            .locator('[data-layout-overlay="Tooltip floats above the page"]')
            .filter({ hasText: "in place of the characters’ faces" })
        ).toBeVisible()
        const plainBox = await section.boundingBox()
        await expectLayout(page, info, `this-chat-plain-${width}-${theme}`, { scope })
        await tab.screenshot({ path: info.outputPath(`this-chat-plain-${width}-${theme}.png`) })

        const picker = section.locator("[data-chat-picture-picker]")
        const toast = (text: string) => page.locator("[data-toast]").filter({ hasText: text })
        const shownSrc = async () => {
          const image = section.locator("img")
          await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
          return new URL((await image.getAttribute("src"))!, server.url).searchParams.get("id")
        }
        // What isn't an image is refused, and says so.
        await picker.setInputFiles({ name: "notes.png", mimeType: "image/png", buffer: Buffer.from("not an image") })
        await expect(section.getByRole("alert")).toContainText("PNG, JPEG, GIF or WebP")
        await picker.setInputFiles({ name: "lighthouse.png", mimeType: "image/png", buffer: portraitPng() })
        await expect(section.getByText("This chat’s own", { exact: true })).toBeVisible()
        await expect(section.getByRole("alert")).toHaveCount(0)
        await expect(toast("Picture set")).toBeVisible()
        const first = await shownSrc()
        // The picture takes the box that was reserved for it: nothing in the section moved.
        expect((await section.boundingBox())!.height).toBe(plainBox!.height)
        if (width === 1440) await expect(page.locator("[data-chat-picture] img")).toBeVisible()
        await expectLayout(page, info, `this-chat-picture-${width}-${theme}`, { scope })
        await tab.screenshot({ path: info.outputPath(`this-chat-picture-${width}-${theme}.png`) })

        // Changed, then Undo puts the first one back.
        await picker.setInputFiles({ name: "harbor.png", mimeType: "image/png", buffer: portraitPng([], 5) })
        await expect(toast("Picture changed")).toBeVisible()
        expect(await shownSrc()).not.toBe(first)
        await toast("Picture changed").getByRole("button", { name: "Undo", exact: true }).click()
        await expect.poll(shownSrc).toBe(first)
        // Removed, then Undo.
        await section.getByRole("button", { name: "Remove", exact: true }).click()
        await expect(section.getByText("The characters’ faces", { exact: true })).toBeVisible()
        await toast("Picture removed").getByRole("button", { name: "Undo", exact: true }).click()
        await expect(section.getByText("This chat’s own", { exact: true })).toBeVisible()
        expect(await shownSrc()).toBe(first)

        // It survives a reload, and the header shows it where it shows faces.
        await page.reload()
        const again = (await openPanel(page, "This chat")).getByRole("region", { name: "Chat picture", exact: true })
        await expect(again.getByText("This chat’s own", { exact: true })).toBeVisible()
        if (width === 1440) {
          await expect(page.locator("[data-chat-picture] img")).toBeVisible()
          await page
            .locator("header")
            .first()
            .screenshot({ path: info.outputPath(`header-${width}-${theme}.png`) })
        } else await closePanel(page)

        // The chats list: one picture for the chat, where its two characters' faces were; the
        // other chat keeps its character's face.
        await showAppNavigation(page)
        const list = page.locator("[data-shell-list]").filter({ visible: true })
        const row = (chatId: string) =>
          list.locator("[data-fork-row]").filter({ has: page.locator(`[data-chat-id="${chatId}"]`) })
        await expect(row(seed.pictured).locator("[data-row-portraits] [data-portrait]")).toHaveCount(1)
        await expect(row(seed.pictured).locator("[data-row-portraits] img")).toHaveCount(1)
        await expect(row(seed.plain).locator("[data-row-portraits] img")).toHaveCount(0)
        await expect
          .poll(() =>
            row(seed.pictured)
              .locator("[data-row-portraits] img")
              .evaluate((img: HTMLImageElement) => img.naturalWidth)
          )
          .toBeGreaterThan(0)
        const pictured = (await row(seed.pictured).boundingBox())!.height
        await expectLayout(page, info, `chats-list-picture-${width}-${theme}`, { scope: "[data-shell-list]" })
        await list.screenshot({ path: info.outputPath(`chats-list-picture-${width}-${theme}.png`) })
        await hideAppNavigation(page)

        // Removed for good: the faces are back, in a row as tall as it was with the picture.
        const panel = await openPanel(page, "This chat")
        await panel
          .getByRole("region", { name: "Chat picture", exact: true })
          .getByRole("button", { name: "Remove", exact: true })
          .click()
        await expect(toast("Picture removed")).toBeVisible()
        if (width === 390) await closePanel(page)
        await showAppNavigation(page)
        await expect(row(seed.pictured).locator("[data-row-portraits] [data-portrait]")).toHaveCount(2)
        expect((await row(seed.pictured).boundingBox())!.height).toBe(pictured)
        await expectLayout(page, info, `chats-list-faces-${width}-${theme}`, { scope: "[data-shell-list]" })
        await list.screenshot({ path: info.outputPath(`chats-list-faces-${width}-${theme}.png`) })
        await hideAppNavigation(page)
      } finally {
        await server.stop()
      }
    })
  }
