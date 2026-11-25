// A workshop's attached image in the request inspector: the image block shows inside its
// `<attachment … image_block="true">` tag pair in the message it was sent with, and opens in the
// image viewer on a click. Synthetic image and a scripted loopback provider.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startWorkshopProvider } from "./support/workshopProvider.ts"

const server = serverPerFile(withAdmin)
let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = process.env.SCREENSHOT_DIR

test.beforeAll(async () => {
  provider = await startWorkshopProvider({ perTask: true, calls: [], answer: "I can see the photo." })
  await admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic vision workshop",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "workshop-small",
        overrides: { vision: true }
      })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

test("inspector: a workshop's sent image sits inside its attachment tags and opens in the viewer", async ({ page }) => {
  test.setTimeout(180_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.emulateMedia({ colorScheme: "dark" })
  const workshop = await admin((api) => api.CreateWorkshop({ title: "Photo workshop" }))
  await page.goto(`${server().url}/chats/${workshop.id}`)
  const jpg = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = 400
      canvas.height = 300
      const ctx = canvas.getContext("2d")!
      ctx.fillStyle = "#31576a"
      ctx.fillRect(0, 0, 400, 300)
      ctx.fillStyle = "#dbb480"
      ctx.beginPath()
      ctx.arc(130, 120, 60, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = "#f6eddc"
      ctx.fillRect(200, 170, 160, 90)
      return canvas.toDataURL("image/jpeg", 0.9).split(",")[1]!
    }),
    "base64"
  )
  await expect(page.getByTestId("composer")).toBeVisible()
  await expect(page.getByRole("button", { name: "Attach", exact: true })).toBeEnabled()
  await page.getByLabel("Choose files").setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: jpg })
  await expect(page.getByText("Saved in /files/Attachments.")).toBeVisible()
  await page.getByLabel("Message", { exact: true }).fill("What is in this photo?")
  await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
  await expect(page.getByRole("article").filter({ hasText: "I can see the photo." })).toBeVisible({ timeout: 60_000 })

  const reply = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.GetChat({ chatId: workshop.id })
      const window = yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: chat.activeLeafSlotId,
        range: { _tag: "Bottom" },
        limit: 1
      })
      return window.entries.at(-1)!.version
    })
  )
  for (const width of [1920, 1250]) {
    await page.setViewportSize({ width, height: 1080 })
    await page.goto(`${server().url}/chats/${workshop.id}/context/${reply.id}`)
    const expand = page.getByRole("button", { name: "Expand every turn", exact: true })
    if (await expand.isVisible()) await expand.click()
    const thumbnail = page.getByRole("button", { name: /^Image 1, sent to the model, / })
    await expect(thumbnail.locator("img")).toBeVisible()
    await expect(thumbnail.locator("img")).toHaveJSProperty("complete", true)
    const open = page.getByText(/^<attachment filename="photo\.jpg".*image_block="true">$/)
    const close = page.getByText("</attachment>", { exact: true })
    await expect(open).toHaveCount(1)
    const [a, t, c] = await Promise.all([open.boundingBox(), thumbnail.boundingBox(), close.boundingBox()])
    // Between the two tags, in the message that carries it.
    expect(a!.y + a!.height).toBeLessThanOrEqual(t!.y + 1)
    expect(t!.y + t!.height).toBeLessThanOrEqual(c!.y + 1)
    expect(t!.height).toBeGreaterThan(40)
    expect(t!.height).toBeLessThanOrEqual(170)
    await expect(page.locator("details", { has: thumbnail }).getByText("What is in this photo?")).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await thumbnail.scrollIntoViewIfNeeded()
    if (shots) await page.screenshot({ path: `${shots}/inspector-tagpair-${width}-dark.png` })
    await thumbnail.click()
    await expect(page.getByRole("img", { name: /Image 1/ }).last()).toBeVisible()
    if (shots) await page.screenshot({ path: `${shots}/inspector-tagpair-open-${width}-dark.png` })
    await page.keyboard.press("Escape")
  }
})
