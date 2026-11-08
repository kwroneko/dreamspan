import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { apiLogin, ADMIN, serverPerFile, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { messageMenu, showActions } from "./support/message.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200", FAKE_GENERATOR_TOKENS: "20" })
const tooltip = (page: Page) => page.locator('[data-layout-overlay="Tooltip floats above the page"]')
/** The viewer's zoom row: the slider, Fit and 100%, each explained. */
const expectZoomControls = async (page: Page, scope: Locator) => {
  await expect(scope.getByRole("slider", { name: "Zoom" })).toBeVisible()
  const fit = scope.getByRole("button", { name: "Fit", exact: true })
  await expect(fit).toHaveAttribute("aria-pressed", "true")
  await fit.hover()
  await expect(tooltip(page)).toHaveText("Fit: show all of the picture")
  await scope.getByRole("button", { name: "100%", exact: true }).click()
  await expect(scope.getByRole("button", { name: "100%", exact: true })).toHaveAttribute("aria-pressed", "true")
  await fit.click()
  await page.mouse.move(0, 0)
}
/** The image column's viewer on a wide screen; on a phone, its full-screen viewer. */
const expectViewerOpen = async (page: Page, width: number, name: string) => {
  const viewer =
    width >= 1024
      ? page.locator("[data-portrait-column]").getByRole("complementary", { name: `${name}'s portrait`, exact: true })
      : page.locator('[data-layout-overlay="The full-screen viewer covers the page"]')
  await expect(viewer).toBeVisible()
  if (width < 1024) await expect(viewer.getByRole("heading", { name, exact: true })).toBeVisible()
  await expect(page.locator("[data-picture-peek]")).toHaveCount(0)
  return viewer
}
const closeViewer = async (page: Page, width: number, name: string) => {
  const viewer = await expectViewerOpen(page, width, name)
  await viewer.getByRole("button", { name: width >= 1024 ? "Close the portrait" : "Close", exact: true }).click()
  await expect(viewer).toHaveCount(0)
}
const openChat = async (page: Page, title: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats`)
  await page.getByLabel("Title of the new chat").fill(title)
  await page.getByRole("button", { name: "New chat" }).click()
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
  await expect(page.getByRole("button", { name: "Attach images", exact: true })).toBeEnabled()
}
// Synthetic costume sketch, drawn here; no external or owner media.
const drawing = async (page: Page) =>
  Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = 480
      canvas.height = 600
      const ctx = canvas.getContext("2d")!
      ctx.fillStyle = "#f6eddc"
      ctx.fillRect(0, 0, 480, 600)
      ctx.fillStyle = "#31576a"
      ctx.beginPath()
      ctx.moveTo(240, 115)
      ctx.lineTo(95, 485)
      ctx.lineTo(385, 485)
      ctx.fill()
      ctx.fillStyle = "#dbb480"
      ctx.beginPath()
      ctx.arc(240, 95, 42, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = "#c58b43"
      ctx.lineWidth = 12
      ctx.beginPath()
      ctx.moveTo(240, 155)
      ctx.lineTo(240, 485)
      ctx.stroke()
      ctx.fillStyle = "#31576a"
      ctx.font = "22px sans-serif"
      ctx.fillText("Harbor keeper · costume study", 45, 555)
      return canvas.toDataURL("image/png").split(",")[1]!
    }),
    "base64"
  )

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`image attachments ${width} ${colorScheme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme })
      const page = await context.newPage()
      await openChat(page, `Costume study ${width} ${colorScheme}`)
      await page.getByLabel("Message", { exact: true }).fill("A costume study for the harbor keeper.")
      await page
        .getByLabel("Choose images")
        .setInputFiles({ name: "costume.png", mimeType: "image/png", buffer: await drawing(page) })
      const attached = page.getByRole("list", { name: "Attached images" })
      await expect(attached.getByRole("img")).toHaveCount(1)
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
      await page.reload()
      await expect(attached.getByRole("img")).toHaveCount(1)
      await expect(page.getByLabel("Message", { exact: true })).toHaveValue("A costume study for the harbor keeper.")
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
      const screenshots = process.env.SCREENSHOT_DIR
      if (screenshots) await page.screenshot({ path: join(screenshots, `draft-${width}-${colorScheme}.png`) })

      // Not sent yet, a click peeks at it in a modal with the column's viewer, never the column.
      await attached.getByRole("button", { name: "View costume.png", exact: true }).click()
      const peek = page.getByRole("dialog", { name: "costume.png", exact: true })
      await expect(peek.locator("[data-picture-peek]")).toBeVisible()
      await expectZoomControls(page, peek)
      const peeked = peek.getByRole("img", { name: "costume.png at full size", exact: true })
      await expect.poll(() => peeked.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480)
      await expect(page.locator("[data-portrait-column]")).toHaveCount(0)
      if (screenshots) await page.screenshot({ path: join(screenshots, `peek-${width}-${colorScheme}.png`) })
      await expectLayout(page, test.info(), `attachment-peek-${width}-${colorScheme}`, {
        scope: '[data-layout-overlay="Modal dialog covers the page"]'
      })
      await page.keyboard.press("Escape")
      await expect(peek).toHaveCount(0)

      // Its corner button opens it in the image column, explained on hover; shown always on touch.
      const thumb = attached.getByRole("button", { name: "View costume.png", exact: true })
      const toColumn = attached.getByRole("button", { name: "Open in image column", exact: true })
      // Closing the peek returns focus to the thumbnail, which shows the button too.
      await expect(thumb).toBeFocused()
      await thumb.blur()
      await page.mouse.move(0, 0)
      await expect(toColumn).toHaveCSS("opacity", "0")
      await thumb.hover()
      await expect(toColumn).toHaveCSS("opacity", "1")
      await toColumn.hover()
      await expect(tooltip(page)).toHaveText("Opens this image in the image column, beside the chat.")
      await expectLayout(page, test.info(), `attachment-thumbnail-${width}-${colorScheme}`, {
        scope: '[aria-label="Image attachments"]',
        hovered: true
      })
      await toColumn.click()
      await closeViewer(page, width, "costume.png")

      // Its app context menu: Open in image column, Open as a tab, each explained.
      await thumb.click({ button: "right" })
      const menu = page.getByRole("menu", { name: "Image", exact: true })
      await expect(
        menu.getByRole("menuitem", { name: "Open in image column", exact: true })
      ).toHaveAccessibleDescription("Opens this image in the image column.")
      await expect(menu.getByRole("menuitem", { name: "Open as a tab", exact: true })).toHaveAccessibleDescription(
        /^Opens this image as a tab/
      )
      await expectLayout(page, test.info(), `attachment-menu-${width}-${colorScheme}`, {
        scope: '[data-layout-overlay="Context menu floats above the page"]'
      })
      await menu.getByRole("menuitem", { name: "Open in image column", exact: true }).click()
      await closeViewer(page, width, "costume.png")

      await page.getByRole("button", { name: "Send", exact: true }).click()
      await expect(page.getByRole("button", { name: "View image 1" })).toBeVisible()
      await expect(attached).toHaveCount(0)
      // Sent, a click opens it in the image column (full screen on a phone), as a portrait opens.
      const sent = page.getByRole("button", { name: "View image 1" })
      await sent.hover()
      await expect(tooltip(page)).toContainText("Opens this image in the image viewer.")
      await sent.click()
      const viewer = await expectViewerOpen(page, width, "costume.png")
      await expectZoomControls(page, viewer)
      await expect
        .poll(() =>
          viewer
            .getByRole("img", { name: "costume.png's full image" })
            .evaluate((img: HTMLImageElement) => img.naturalWidth)
        )
        .toBe(480)
      if (screenshots) await page.screenshot({ path: join(screenshots, `viewer-${width}-${colorScheme}.png`) })
      await expectLayout(page, test.info(), `attachment-viewer-${width}-${colorScheme}`, {
        scope:
          width >= 1024 ? "[data-portrait-column]" : '[data-layout-overlay="The full-screen viewer covers the page"]'
      })
      await page.keyboard.press("Escape")
      await expect(viewer).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      // The timeline image has the same context menu.
      await sent.click({ button: "right" })
      const sentMenu = page.getByRole("menu", { name: "Image", exact: true })
      await expect(sentMenu.getByRole("menuitem")).toHaveCount(2)
      await expect(sentMenu.getByRole("menuitem", { name: "Open in image column", exact: true })).toBeEnabled()
      await expect(sentMenu.getByRole("menuitem", { name: "Open as a tab", exact: true })).toHaveAccessibleDescription(
        /^Opens this image as a tab in the chat's frame\. Dragging it onto a frame does the same\.$/
      )
      await page.keyboard.press("Escape")
      await context.close()
    })
  }
}

test("paste, chat drop, removal, upload retry, and image-only send", async ({ page }) => {
  await openChat(page, "Direct image input")
  const buffer = await drawing(page)
  const base64 = buffer.toString("base64")
  const transfer = async (kind: "paste" | "drop", name: string) => {
    await page.evaluate(
      ({ kind, name, base64 }) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
        const data = new DataTransfer()
        data.items.add(new File([bytes], name, { type: "image/png" }))
        const target =
          kind === "paste"
            ? document.querySelector('[data-testid="composer"]')!
            : document.querySelector('[data-testid="messages"]')!
        target.dispatchEvent(
          kind === "paste"
            ? new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
            : new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true })
        )
      },
      { kind, name, base64 }
    )
  }
  await transfer("paste", "pasted.png")
  await expect(page.getByRole("button", { name: "Remove pasted.png" })).toBeVisible()
  await transfer("drop", "dropped.png")
  await expect(page.getByRole("list", { name: "Attached images" }).getByRole("img")).toHaveCount(2)
  await page.getByRole("button", { name: "Remove pasted.png" }).click()
  await expect(page.getByRole("list", { name: "Attached images" }).getByRole("img")).toHaveCount(1)
  // A failed upload retains the blob and can replay it after refresh.
  await page.route("**/chat/image", (route) => route.abort())
  await transfer("paste", "retry.png")
  await expect(page.getByRole("alert")).toContainText("kept in this browser")
  await page.unroute("**/chat/image")
  await page.reload()
  await expect(page.getByRole("list", { name: "Attached images" }).getByRole("img")).toHaveCount(2)
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  // Image-only Send is enabled; no textual placeholder needs to be typed.
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(
    page.getByRole("article", { name: "Your message" }).getByRole("button", { name: "View image" })
  ).toHaveCount(2)
  await expect(page.getByRole("list", { name: "Attached images" })).toHaveCount(0)
})

test("an attachment added during a send survives its acknowledgement, and an unanswered send survives reload", async ({
  page
}) => {
  let release: (() => void) | null = null
  let hold = true
  let holdPath = false
  const paths: Array<() => void> = []
  await page.routeWebSocket("**/rpc", (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((message) => {
      if (hold && String(message).includes('"tag":"SendMessage"')) release = () => upstream.send(message)
      else if (holdPath && String(message).includes('"tag":"ReadPath"')) paths.push(() => upstream.send(message))
      else upstream.send(message)
    })
    upstream.onMessage((message) => socket.send(message))
  })
  await openChat(page, "Image send race")
  const buffer = await drawing(page)
  const attach = async (name: string) =>
    page.getByLabel("Choose images").setInputFiles({ name, mimeType: "image/png", buffer })
  await attach("first.png")
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect.poll(() => release !== null).toBe(true)
  await attach("next.png")
  await expect(page.getByRole("list", { name: "Attached images" }).getByRole("img")).toHaveCount(2)
  hold = false
  release!()
  await expect(page.getByRole("list", { name: "Attached images" }).getByRole("img")).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Remove next.png" })).toBeVisible()
  // Now lose a send before it reaches the server: its blob/reference must remain recoverable.
  hold = true
  release = null
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect.poll(() => release !== null).toBe(true)
  holdPath = true
  await page.reload()
  await expect.poll(() => paths.length > 0).toBe(true)
  // No image reconciler may open a temporary current-fork scope while the real
  // fork is unknown: it could erase the durable marker before the fork reads it.
  await expect(page.getByRole("button", { name: "Attach images", exact: true })).toHaveCount(0)
  holdPath = false
  for (const forward of paths.splice(0)) forward()
  await expect(page.getByRole("button", { name: "Remove next.png" })).toBeVisible()
  await expect(page.getByRole("alert")).toContainText("previous send was not acknowledged")
  hold = false
})

test("a text-only model is called out before sending", async ({ page }) => {
  await openChat(page, "Vision capability")
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic text only",
          baseUrl: "http://127.0.0.1:9/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "text-only",
        overrides: { vision: false }
      })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
    })
  )
  await page.reload()
  await expect(page.getByRole("button", { name: "Attach images", exact: true })).toBeEnabled()
  await page
    .getByLabel("Choose images")
    .setInputFiles({ name: "vision.png", mimeType: "image/png", buffer: await drawing(page) })
  await expect(page.getByRole("status").filter({ hasText: "This model cannot see images" })).toBeVisible()
})

test("uploaded attachment drafts follow the account across browsers, including removal", async ({ browser }) => {
  const first = await browser.newContext()
  const page = await first.newPage()
  await openChat(page, "Server attachment draft")
  await page
    .getByLabel("Choose images")
    .setInputFiles({ name: "shared.png", mimeType: "image/png", buffer: await drawing(page) })
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  const second = await browser.newContext()
  await apiLogin(second.request, server(), ADMIN.handle, ADMIN.password)
  const elsewhere = await second.newPage()
  await elsewhere.goto(page.url())
  await expect(elsewhere.getByRole("button", { name: "Remove shared.png" })).toBeVisible()
  await elsewhere.getByRole("button", { name: "Remove shared.png" }).click()
  await expect(elsewhere.getByRole("list", { name: "Attached images" })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("button", { name: "Attach images", exact: true })).toBeEnabled()
  await expect(page.getByRole("list", { name: "Attached images" })).toHaveCount(0)
  await first.close()
  await second.close()
})

test("unavailable attachment storage leaves text-only sending usable", async ({ page }) => {
  await page.addInitScript(() => {
    const original = IDBFactory.prototype.open
    IDBFactory.prototype.open = function (name, version) {
      if (name === "rp.message-images") throw new Error("Synthetic attachment storage failure")
      return original.call(this, name, version)
    }
  })
  await openChat(page, "Storage unavailable")
  await page.getByLabel("Message", { exact: true }).fill("This text can still be sent.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("article", { name: "Your message" })).toContainText("This text can still be sent.")
})

test("attachment order follows selection rather than UUID key order", async ({ page }) => {
  await page.addInitScript(() => {
    let sequence = 999999999999
    Object.defineProperty(crypto, "randomUUID", { value: () => `ffffffff-ffff-4fff-8fff-${sequence--}` })
  })
  await openChat(page, "Image order")
  const buffer = await drawing(page)
  for (const name of ["first.png", "second.png", "third.png"]) {
    await page.getByLabel("Choose images").setInputFiles({ name, mimeType: "image/png", buffer })
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  }
  await expect
    .poll(() =>
      page
        .getByRole("list", { name: "Attached images" })
        .getByRole("img")
        .evaluateAll((images) => images.map((image) => image.getAttribute("alt")))
    )
    .toEqual(["first.png", "second.png", "third.png"])
})

test("all selected images survive a failed first upload and reload", async ({ page }) => {
  await page.addInitScript(() => {
    let sequence = 999999999999
    Object.defineProperty(crypto, "randomUUID", { value: () => `eeeeeeee-eeee-4eee-8eee-${sequence--}` })
  })
  await openChat(page, "Offline image batch")
  const buffer = await drawing(page)
  await page.route("**/chat/image", (route) => route.abort())
  await page
    .getByLabel("Choose images")
    .setInputFiles(["first.png", "second.png"].map((name) => ({ name, mimeType: "image/png", buffer })))
  await expect(page.getByRole("alert")).toContainText("kept in this browser")
  const attached = page.getByRole("list", { name: "Attached images" })
  await expect(attached.getByRole("img")).toHaveCount(2)
  // Pending selection order must survive IndexedDB's UUID-key ordering too.
  await page.reload()
  await expect(page.getByRole("alert")).toContainText("kept in this browser")
  await expect
    .poll(() => attached.getByRole("img").evaluateAll((images) => images.map((image) => image.getAttribute("alt"))))
    .toEqual(["first.png", "second.png"])
  await page.unroute("**/chat/image")
  await page.reload()
  await expect(attached.getByRole("img")).toHaveCount(2)
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  await expect(attached.getByRole("img").first()).toHaveAttribute("src", /library\/media/)
  await expect
    .poll(() => attached.getByRole("img").evaluateAll((images) => images.map((image) => image.getAttribute("alt"))))
    .toEqual(["first.png", "second.png"])
})

test("an image awaiting upload has a working local thumbnail under CSP", async ({ page }) => {
  await openChat(page, "Offline image preview")
  const violations: string[] = []
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text())
  })
  await page.route("**/chat/image", (route) => route.abort())
  await page
    .getByLabel("Choose images")
    .setInputFiles({ name: "pending.png", mimeType: "image/png", buffer: await drawing(page) })
  await expect(page.getByRole("alert")).toContainText("kept in this browser")
  const thumbnail = page.getByRole("list", { name: "Attached images" }).getByRole("img")
  await expect.poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480)
  expect(violations).toEqual([])
})

test("hide images covers draft, message and full-size attachment surfaces", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("rp.images", "hide"))
  await openChat(page, "Concealed images")
  await page
    .getByLabel("Choose images")
    .setInputFiles({ name: "concealed.png", mimeType: "image/png", buffer: await drawing(page) })
  const draft = page.getByRole("list", { name: "Attached images" })
  await expect(draft.locator("img")).toHaveCSS("visibility", "hidden")
  await expect(draft.getByText("Image hidden", { exact: true })).toBeVisible()
  // Not sent, its peek hides it too, and says so.
  await draft.getByRole("button", { name: "View concealed.png" }).click()
  const peek = page.locator("[data-picture-peek]")
  // Hidden images leave the accessibility tree, so these find them by their alt text.
  await expect(peek.locator('img[alt="concealed.png at full size"]')).toHaveCSS("visibility", "hidden")
  await expect(peek.getByText("Images are hidden in this browser.", { exact: false })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(peek).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Send", exact: true }).click()
  const message = page.getByRole("article", { name: "Your message" })
  await expect(message.locator("img")).toHaveCSS("visibility", "hidden")
  await expect(message.getByText("Image hidden", { exact: true })).toBeVisible()
  await message.getByRole("button", { name: "View image 1" }).click()
  const viewer = page.locator("[data-portrait-column]")
  await expect(viewer.locator(`img[alt="concealed.png's full image"]`)).toHaveCSS("visibility", "hidden")
  await expect(viewer.getByText("Images are hidden in this browser.", { exact: false })).toBeVisible()
})

test("an attachment still uploading peeks from its local copy; the column and tab wait for the upload", async ({
  page
}) => {
  await openChat(page, "Uploading image")
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route("**/chat/image", async (route) => {
    await held
    await route.continue()
  })
  await page
    .getByLabel("Choose images")
    .setInputFiles({ name: "slow.png", mimeType: "image/png", buffer: await drawing(page) })
  const attached = page.getByRole("list", { name: "Attached images" })
  const thumb = attached.getByRole("button", { name: "View slow.png", exact: true })
  await expect(thumb).toBeVisible()
  // The corner button says why it waits, and stays disabled.
  const toColumn = attached.getByRole("button", { name: "Open in image column", exact: true })
  await thumb.hover()
  await expect(toColumn).toHaveAttribute("aria-disabled", "true")
  await toColumn.hover()
  await expect(tooltip(page)).toHaveText("This image can open there once it has finished uploading.")
  // So do the context menu's items.
  await thumb.click({ button: "right" })
  const menu = page.getByRole("menu", { name: "Image", exact: true })
  for (const name of ["Open in image column", "Open as a tab"]) {
    const item = menu.getByRole("menuitem", { name, exact: true })
    await expect(item).toHaveAttribute("aria-disabled", "true")
    await expect(item).toHaveAccessibleDescription("This image can open there once it has finished uploading.")
  }
  await page.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)
  // The peek shows the browser's own copy meanwhile.
  await thumb.click()
  const peeked = page.locator("[data-picture-peek]").getByRole("img", { name: "slow.png at full size" })
  await expect.poll(() => peeked.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480)
  await expect(peeked).toHaveAttribute("src", /^blob:/)
  await page.locator("[data-window-close]").click()
  await expect(peeked).toHaveCount(0)
  release()
  await expect(toColumn).not.toHaveAttribute("aria-disabled", "true")
  await thumb.hover()
  await toColumn.click()
  await expect(page.getByRole("complementary", { name: "slow.png's portrait", exact: true })).toBeVisible()
})

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`message images toggle in and out of the context, and say why a rule leaves one out ${width} ${colorScheme}`, async ({
      browser
    }) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme,
        hasTouch: width === 390
      })
      const page = await context.newPage()
      await openChat(page, `Image context ${width} ${colorScheme}`)
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const connection = yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              name: "Synthetic vision",
              baseUrl: "http://127.0.0.1:9/v1",
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            }
          })
          const model = yield* api.AddUserModel({
            connectionId: connection.id,
            key: "one-image",
            overrides: { vision: true, maxImages: 1 }
          })
          yield* api.SetGenerationDefaults({
            defaults: { model: { connection: connection.id, model: model.id }, preset: null }
          })
        })
      )
      await page.reload()
      const buffer = await drawing(page)
      await page.getByLabel("Message", { exact: true }).fill("Two studies.")
      await page.getByLabel("Choose images").setInputFiles([
        { name: "first.png", mimeType: "image/png", buffer },
        // Different bytes, so a different media id: identical images are one image to the context.
        { name: "second.png", mimeType: "image/png", buffer: Buffer.concat([buffer, Buffer.from("second")]) }
      ])
      await expect(page.getByRole("list", { name: "Attached images" }).getByRole("img")).toHaveCount(2)
      await page.getByRole("button", { name: "Send", exact: true }).click()
      const message = page.getByRole("article", { name: "Your message" })
      const limited = message.getByRole("button", {
        name: "Image 1 isn’t sent to the model: Only the last image is sent to this model"
      })
      await expect(limited).toBeVisible()
      await expect(limited).toHaveAttribute("aria-pressed", "true")
      await expect(limited).toHaveAttribute("aria-disabled", "true")
      await expect(message.getByRole("button", { name: /^View image 1 \(not sent/ })).toBeVisible()
      await message.getByRole("button", { name: "View image 1", exact: false }).first().hover()
      await expect(page.getByText("Not sent to the model: Only the last image is sent to this model")).toBeVisible()
      const screenshots = process.env.SCREENSHOT_DIR
      if (screenshots) await page.screenshot({ path: join(screenshots, `image-rule-${width}-${colorScheme}.png`) })

      const take = message.getByRole("button", { name: "Take image 2 out of the context" })
      if (width === 390) {
        // No hover on a phone: the in-context toggle must already be visible and tappable.
        await page.mouse.move(0, 0)
        await expect(take).toHaveCSS("opacity", "1")
        await take.tap()
      } else {
        await page.mouse.move(0, 0)
        await expect(take).toHaveCSS("opacity", "0")
        const image = message.getByRole("button", { name: "View image 2", exact: true })
        const box = await take.boundingBox()
        await image.focus()
        await expect(take).toHaveCSS("opacity", "1")
        await page.keyboard.press("Tab")
        await expect(take).toBeFocused()
        await expect(page.getByText("Click to take image 2 out of the context")).toBeVisible()
        expect(await take.boundingBox()).toEqual(box)
        await take.blur()
        await message.getByRole("button", { name: "View image 2", exact: true }).hover()
        await expect(take).toHaveCSS("opacity", "1")
        await take.click()
      }
      const back = message.getByRole("button", { name: "Put image 2 back into the context" })
      await expect(back).toHaveAttribute("aria-pressed", "true")
      await page.mouse.move(0, 0)
      await back.hover()
      await expect(page.getByText("Click to put image 2 back into the context")).toBeVisible()
      // The limit counts only what's sent: the first image is sent now.
      await expect(message.getByRole("button", { name: "Take image 1 out of the context" })).toBeEnabled()
      await page.mouse.move(0, 0)
      await expect(back).toHaveCSS("opacity", "1")
      if (screenshots) await page.screenshot({ path: join(screenshots, `image-taken-out-${width}-${colorScheme}.png`) })
      await page.reload()
      await expect(message.getByRole("button", { name: "Put image 2 back into the context" })).toBeVisible()
      await message.getByRole("button", { name: "Put image 2 back into the context" }).click()
      await expect(limited).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      await context.close()
    })
  }
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`editing a message keeps, adds or removes its images ${width} ${colorScheme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme })
      const page = await context.newPage()
      await openChat(page, `Edit images ${width} ${colorScheme}`)
      const buffer = await drawing(page)
      await page.getByLabel("Message", { exact: true }).fill("A study to revise.")
      await page.getByLabel("Choose images").setInputFiles({ name: "study.png", mimeType: "image/png", buffer })
      await expect(page.getByRole("list", { name: "Attached images" }).getByRole("img")).toHaveCount(1)
      await page.getByRole("button", { name: "Send", exact: true }).click()
      const message = page.getByRole("article", { name: "Your message" })
      await expect(message.getByRole("button", { name: "View image 1" })).toBeVisible()
      await showActions(message)
      await message.getByRole("button", { name: "Edit", exact: true }).click()
      const images = message.getByRole("list", { name: "Images of this version" })
      await expect(images.getByRole("img")).toHaveCount(1)
      // The editor's own controls stand in for the message's images while it's open.
      await expect(message.getByRole("button", { name: "View image 1" })).toHaveCount(0)
      await message.getByLabel("Choose images for this version").setInputFiles({
        name: "revision.png",
        mimeType: "image/png",
        buffer: Buffer.concat([buffer, Buffer.from("revision")])
      })
      await expect(images.getByRole("img")).toHaveCount(2)
      await images.getByRole("button", { name: "Remove study.png" }).click()
      await expect(images.getByRole("img")).toHaveCount(1)
      // An image-only edit is a server draft, even though its text never changed.
      await expect(message.getByText("Uploading…", { exact: true })).toHaveCount(0)
      await expect
        .poll(() =>
          asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
            Effect.gen(function* () {
              const chats = yield* api.ListChats({ limit: 500, before: null })
              const chat = chats.find((item) => item.title === `Edit images ${width} ${colorScheme}`)!
              const drafts = yield* api.MessageDrafts({ chatId: chat.id })
              return drafts[0]?.images?.map((image) => image.altText)
            })
          )
        )
        .toEqual(["revision.png"])
      await page.reload()
      await expect(images.getByRole("img", { name: "revision.png" })).toBeVisible()
      const screenshots = process.env.SCREENSHOT_DIR
      if (screenshots) await page.screenshot({ path: join(screenshots, `edit-images-${width}-${colorScheme}.png`) })
      const elsewhere = await browser.newContext({ viewport: { width, height: 900 }, colorScheme })
      await apiLogin(elsewhere.request, server(), ADMIN.handle, ADMIN.password)
      const remote = await elsewhere.newPage()
      await remote.goto(page.url())
      const remoteMessage = remote.getByRole("article", { name: "Your message" })
      await expect(
        remoteMessage.getByRole("list", { name: "Images of this version" }).getByRole("img", { name: "revision.png" })
      ).toBeVisible()
      await remoteMessage.getByRole("button", { name: "Save", exact: true }).click()
      await expect(remoteMessage.getByRole("list", { name: "Images of this version" })).toHaveCount(0)
      await page.reload()
      await elsewhere.close()
      await expect(images).toHaveCount(0)
      await expect(message.getByRole("button", { name: /^View image/ })).toHaveCount(1)
      await expect(message.getByRole("img", { name: "revision.png" })).toBeVisible()
      // Restoring an amendment brings back both the text and the earlier image set.
      await messageMenu(message, "Saved amendment history")
      const history = page.getByRole("dialog", { name: "Saved amendment history" })
      await expect(history).toContainText("1 image")
      if (screenshots)
        await page.screenshot({ path: join(screenshots, `image-amendments-${width}-${colorScheme}.png`) })
      await history.getByRole("button", { name: "Restore saved text" }).first().click()
      await expect(message.getByRole("img", { name: "study.png" })).toBeVisible()
      await expect(message.getByRole("img", { name: "revision.png" })).toHaveCount(0)
      // The composer's attachments were never touched by the editor.
      await expect(page.getByRole("list", { name: "Attached images" })).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      await context.close()
    })
  }
}

test("a generated version's editor adds pasted/dropped images to a new version and waits for upload", async ({
  page
}) => {
  await openChat(page, "Generated image edit")
  await page.getByLabel("Message", { exact: true }).fill("Describe this harbor.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  const reply = page.getByRole("article", { name: "Reply" }).last()
  await expect(reply).toBeVisible()
  await expect(reply.getByText("generating", { exact: true })).toHaveCount(0)
  await showActions(reply)
  await reply.getByRole("button", { name: "Edit", exact: true }).click()
  const buffer = await drawing(page)
  const transfer = async (kind: "paste" | "drop", name: string) => {
    await reply.locator("form").evaluate(
      (form, { kind, name, base64 }) => {
        const data = new DataTransfer()
        data.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], name, { type: "image/png" }))
        form.dispatchEvent(
          kind === "paste"
            ? new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
            : new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true })
        )
      },
      { kind, name, base64: buffer.toString("base64") }
    )
  }
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/chat/image", async (route) => {
    await held
    await route.continue()
  })
  await transfer("paste", "pasted-edit.png")
  await expect(reply.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  release()
  const images = reply.getByRole("list", { name: "Images of this version" })
  await expect(images.getByRole("img", { name: "pasted-edit.png" })).toBeVisible()
  await page.unroute("**/chat/image")
  await transfer("drop", "dropped-edit.png")
  await expect(images.getByRole("img")).toHaveCount(2)
  await reply.getByRole("button", { name: "Save", exact: true }).click()
  // The edit stays in the same speaker's reply slot, alongside the original version.
  const edited = reply
  await expect(edited.getByRole("button", { name: /^View image/ })).toHaveCount(2)
  await expect(edited.getByRole("group", { name: "Versions" })).toContainText("2/2")
  await edited.getByRole("button", { name: "Previous version" }).click()
  await expect(reply.getByRole("button", { name: /^View image/ })).toHaveCount(0)
  await expect(page.getByRole("list", { name: "Attached images" })).toHaveCount(0)
})
