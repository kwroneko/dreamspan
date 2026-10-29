import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { apiLogin, ADMIN, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200", FAKE_GENERATOR_TOKENS: "20" })
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
      await page.getByRole("button", { name: "Send", exact: true }).click()
      await expect(page.getByRole("button", { name: "View image 1" })).toBeVisible()
      await expect(attached).toHaveCount(0)
      await page.getByRole("button", { name: "View image 1" }).click()
      const viewer = page.getByRole("dialog")
      await expect(viewer.getByRole("img")).toBeVisible()
      await expect(viewer).toHaveCSS("opacity", "1")
      await expect.poll(() => viewer.getByRole("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480)
      if (screenshots) await page.screenshot({ path: join(screenshots, `viewer-${width}-${colorScheme}.png`) })
      await page.keyboard.press("Escape")
      await expect(viewer).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
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
          kind === "paste" ? document.querySelector("#composer")! : document.querySelector('[data-testid="messages"]')!
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
  await page.routeWebSocket("**/rpc", (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((message) => {
      if (hold && String(message).includes('"tag":"SendMessage"')) release = () => upstream.send(message)
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
  await page.reload()
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
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Send", exact: true }).click()
  const message = page.getByRole("article", { name: "Your message" })
  await expect(message.locator("img")).toHaveCSS("visibility", "hidden")
  await expect(message.getByText("Image hidden", { exact: true })).toBeVisible()
  await message.getByRole("button", { name: "View image 1" }).click()
  const viewer = page.getByRole("dialog")
  await expect(viewer.locator("img")).toHaveCSS("visibility", "hidden")
  await expect(viewer.getByText("Image hidden", { exact: true })).toBeVisible()
})
