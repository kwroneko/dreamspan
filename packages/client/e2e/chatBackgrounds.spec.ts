import { expect, test, type Locator } from "@playwright/test"
import { Effect } from "effect"
import sharp from "sharp"
import { closePanel, openPanel } from "./support/panel.ts"
import { gotoWithLayout } from "./support/workbench.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(run: (api: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, run)

const png = (background: string) =>
  sharp({ create: { width: 64, height: 48, channels: 3, background } })
    .png()
    .toBuffer()

const alphaOf = (surface: Locator) =>
  surface.evaluate((node) => {
    const color = getComputedStyle(node).backgroundColor
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext("2d")!
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    return ctx.getImageData(0, 0, 1, 1).data[3]! / 255
  })

const luminance = (rgb: ReadonlyArray<number>) =>
  [0.2126, 0.7152, 0.0722].reduce((sum, weight, channel) => {
    const value = rgb[channel]! / 255
    return sum + weight * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  }, 0)

const contrast = async (surface: Locator, text: Locator) => {
  const [{ data }, ink] = await Promise.all([
    sharp(await surface.screenshot())
      .resize(1, 1, { fit: "fill", kernel: "nearest" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    text.evaluate((node) => {
      const ctx = document.createElement("canvas").getContext("2d")!
      ctx.fillStyle = getComputedStyle(node).color
      ctx.fillRect(0, 0, 1, 1)
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3)
    })
  ])
  const a = luminance(Array.from(data))
  const b = luminance(ink)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`personal backgrounds and the message surface at ${width}px in ${theme}`, async ({ page }) => {
      test.setTimeout(120_000)
      const { chat, workshop, slot } = await admin((api) =>
        Effect.gen(function* () {
          yield* api.SetDisplayPrefs({
            prefs: { chatBackground: { mediaId: null, opacity: 85, fit: "cover", blur: 0 } }
          })
          const chat = yield* api.CreateChat({ title: "Reading test" })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "Mira hears the wind round the shutters."
          })
          if (sent._tag !== "Posted") return yield* Effect.die("Expected a posted message")
          const workshop = yield* api.CreateWorkshop({ title: "Workshop background test", attachTo: chat.id })
          return { chat, workshop, slot: sent.entry.slotId }
        })
      )
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)

      await page.goto(`${server().url}/settings/interface`)
      const gallery = page.getByRole("group", { name: "Background gallery" })
      const file = page.locator('input[type="file"][aria-label="Background image file"]')
      const upload = async (name: string, buffer: Buffer) => {
        const response = page.waitForResponse(
          (response) => response.request().method() === "POST" && response.url().includes("/api/chat-backgrounds?")
        )
        await file.setInputFiles({ name, mimeType: "image/png", buffer })
        const uploaded = await response
        expect(uploaded.ok()).toBeTruthy()
        await expect(gallery.getByRole("button", { name, exact: true })).toBeEnabled()
        return ((await uploaded.json()) as { mediaId: string }).mediaId
      }
      const firstName = "High contrast.png"
      const secondName = "Lake.png"
      const first = await upload(firstName, await png(theme === "light" ? "black" : "white"))
      const second = await upload(secondName, await png("steelblue"))
      await gallery.getByRole("button", { name: firstName, exact: true }).click()
      const prefs = () => admin((api) => api.GetDisplayPrefs({}))
      await expect.poll(async () => (await prefs()).chatBackground.mediaId).toBe(first)

      const wallpaper = page.locator("[data-chat-wallpaper]")
      const surface = page.locator("[data-chat-reading-backdrop]")
      const layer = wallpaper.locator("> div")
      const verifyWallpaper = async (id: string) => {
        await expect(wallpaper).toHaveAttribute("data-chat-wallpaper", id)
        await expect(layer).toHaveCSS("background-image", new RegExp(`/api/media/chat-backgrounds/${id}`))
      }
      await page.goto(`${server().url}/chats/${chat.id}`)
      await verifyWallpaper(first)
      const article = page.locator(`article[data-slot="${slot}"]`)
      const text = article.locator(".markdown")
      await expect(text).toContainText("shutters")
      await expect.poll(() => alphaOf(surface)).toBeCloseTo(0.85, 2)
      expect(await contrast(surface, text)).toBeGreaterThanOrEqual(4.5)

      let panel = await openPanel(page, "Display")
      const opacity = panel.getByRole("slider", { name: "Message box opacity" })
      await opacity.focus()
      await opacity.press("Home")
      await expect.poll(async () => (await prefs()).chatBackground.opacity).toBe(50)
      await panel.getByRole("combobox", { name: "Fit" }).click()
      await page.getByRole("option", { name: "Tile" }).click()
      await expect(layer).toHaveCSS("background-repeat", "repeat")
      await expect.poll(() => alphaOf(surface)).toBeCloseTo(0.5, 2)
      await closePanel(page)
      expect(await contrast(surface, text)).toBeGreaterThanOrEqual(4.5)

      // Entering the editor keeps the existing reading geometry.
      const body = article.locator(".message-content")
      const beforeEdit = await body.boundingBox()
      await text.getByText("Mira hears the wind round the shutters.").dblclick()
      await expect(article.getByRole("textbox", { name: "Message text", exact: true })).toBeFocused()
      expect(await body.boundingBox()).toEqual(beforeEdit)
      await page.keyboard.press("Escape")

      panel = await openPanel(page, "Display")
      const timeline = page.getByTestId("messages")
      const beforeSwitch = await timeline.boundingBox()
      await panel
        .getByRole("group", { name: "Global gallery", exact: true })
        .getByRole("button", { name: secondName, exact: true })
        .click()
      await verifyWallpaper(second)
      await panel
        .getByRole("group", { name: "This chat’s background", exact: true })
        .getByRole("button", { name: "None (solid)", exact: true })
        .click()
      await expect(wallpaper).toHaveCount(0)
      await expect(surface).toHaveCount(0)
      expect(await timeline.boundingBox()).toEqual(beforeSwitch)
      await panel.getByRole("button", { name: "Use default", exact: true }).click()
      await verifyWallpaper(first)
      await expect.poll(async () => (await prefs()).chatBackgrounds[chat.id]).toBeUndefined()
      await closePanel(page)

      await page.goto(`${server().url}/chats/${workshop.id}`)
      await verifyWallpaper(first)
      panel = await openPanel(page, "Display")
      await panel
        .getByRole("group", { name: "Global gallery", exact: true })
        .getByRole("button", { name: secondName, exact: true })
        .click()
      await verifyWallpaper(second)
      if (width === 1440 && theme === "dark") {
        await expect.poll(async () => (await prefs()).chatBackgrounds[workshop.id]).toBe(second)
        await gotoWithLayout(page, server().url, `/chats/${workshop.id}`, [
          "r",
          [0.5, 0.5],
          [0, `/chats/${chat.id}`],
          [0, "="]
        ])
        const frames = page.locator("[data-frame]")
        await expect(frames).toHaveCount(2)
        for (const [index, id] of [first, second].entries()) {
          const frame = frames.nth(index)
          const image = frame.locator("[data-chat-wallpaper]")
          await expect(image).toHaveAttribute("data-chat-wallpaper", id)
          const [frameBounds, imageBounds] = await Promise.all([frame.boundingBox(), image.boundingBox()])
          expect(imageBounds!.x).toBeGreaterThanOrEqual(frameBounds!.x)
          expect(imageBounds!.x + imageBounds!.width).toBeLessThanOrEqual(frameBounds!.x + frameBounds!.width)
        }
        await page.goto(`${server().url}/chats/${chat.id}?panel=workshop&workshop=${workshop.id}`)
        const side = page.locator(`[data-side-chat="${workshop.id}"]`)
        await expect(side.locator("[data-chat-wallpaper]")).toHaveAttribute("data-chat-wallpaper", second)
        await expect(page.locator("[data-chat-main] > [data-chat-wallpaper]")).toHaveAttribute(
          "data-chat-wallpaper",
          first
        )
        await page.goto(`${server().url}/chats/${workshop.id}`)
        panel = await openPanel(page, "Display")
      }
      await panel.getByRole("button", { name: "Use default", exact: true }).click()
      await verifyWallpaper(first)

      await panel.getByRole("button", { name: `Remove ${firstName}`, exact: true }).click()
      await expect(panel.getByRole("button", { name: firstName, exact: true })).toHaveCount(0)
      await expect(wallpaper).toHaveCount(0)
      await panel.getByRole("button", { name: `Remove ${secondName}`, exact: true }).click()
      await expect(
        panel
          .getByRole("group", { name: "Global gallery", exact: true })
          .getByRole("button", { name: secondName, exact: true })
      ).toHaveCount(0)
      await expect.poll(async () => (await prefs()).chatBackground.mediaId).toBeNull()
    })
