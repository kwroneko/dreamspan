import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import sharp from "sharp"
import { filesOf } from "./support/files.ts"
import { messageMenu } from "./support/message.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startWorkshopProvider, STORY_REPLY } from "./support/workshopProvider.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(run: (api: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, run)
const png = (background: string) =>
  sharp({ create: { width: 24, height: 16, channels: 3, background } })
    .png()
    .toBuffer()
const wallpaper = (page: Page) => page.locator("[data-chat-wallpaper]")

const setModel = (baseUrl: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Background fixture",
          baseUrl,
          compat: {},
          providerSettings: { toolLoading: "every" },
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "workshop-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
    })
  )

const login = (page: Page) => apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
const postBackground = async (page: Page, name: string, color: string, chatId?: string) => {
  const params = new URLSearchParams({ name, ...(chatId === undefined ? {} : { chatId }) })
  const response = await page.request.post(`${server().url}/api/chat-backgrounds?${params}`, {
    headers: { "content-type": "application/octet-stream" },
    data: await png(color)
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  return ((await response.json()) as { mediaId: string }).mediaId
}

test("workshops have their own default and a local upload is only in its chat", async ({ page }) => {
  await login(page)
  const [story, workshop] = await admin((api) =>
    Effect.all([api.CreateChat({ title: "Background story" }), api.CreateWorkshop({ title: "Background workshop" })])
  )
  const main = await postBackground(page, "Meadow.png", "#466aa2")
  const other = await postBackground(page, "Study.png", "#d39550")
  await admin((api) =>
    api.SetDisplayPrefs({ prefs: { chatBackground: { mediaId: main }, workshopBackground: "inherit" } })
  )
  await page.goto(`${server().url}/settings/interface`)
  const globalWorkshop = page.getByRole("group", { name: "Workshop background", exact: true })
  await globalWorkshop.getByRole("button", { name: "None (solid)" }).click()
  await expect.poll(async () => (await admin((api) => api.GetDisplayPrefs({}))).workshopBackground).toBeNull()
  await page.goto(`${server().url}/chats/${story.id}`)
  await expect(wallpaper(page)).toHaveAttribute("data-chat-wallpaper", main)
  await page.goto(`${server().url}/chats/${workshop.id}`)
  await expect(page.getByTestId("composer")).toBeVisible()
  await expect(wallpaper(page)).toHaveCount(0)
  const panel = await openPanel(page, "Display")
  await panel
    .getByRole("group", { name: "Workshop background choices" })
    .getByRole("button", { name: "Study.png" })
    .click()
  await expect(wallpaper(page)).toHaveAttribute("data-chat-wallpaper", other)

  await page.goto(`${server().url}/chats/${story.id}`)
  const display = await openPanel(page, "Display")
  const uploading = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes("/api/chat-backgrounds?")
  )
  await display.getByLabel("This chat’s background image file").setInputFiles({
    name: "Sky.png",
    mimeType: "image/png",
    buffer: await png("#53a38d")
  })
  const local = ((await (await uploading).json()) as { mediaId: string }).mediaId
  await expect(wallpaper(page)).toHaveAttribute("data-chat-wallpaper", local)
  await expect(
    display.getByRole("group", { name: "This chat’s images" }).getByRole("button", { name: "Sky.png", exact: true })
  ).toBeVisible()
  await page.goto(`${server().url}/settings/interface`)
  await expect(
    page.getByRole("group", { name: "Background gallery" }).getByRole("button", { name: "Meadow.png", exact: true })
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Sky.png", exact: true })).toHaveCount(0)
})

test("an opted-in story tool changes the live scene, with swipe and branch history", async ({ page }) => {
  const calls = [{ name: "set_chat_background", arguments: { background: "Rainy Tavern.png" } }]
  const provider = await startWorkshopProvider({
    offeredTool: "set_chat_background",
    perTask: true,
    calls,
    answer: "The tavern is quiet tonight."
  })
  try {
    await setModel(provider.baseUrl)
    await login(page)
    const chat = await admin((api) => api.CreateChat({ title: "Scene story" }))
    const main = await postBackground(page, "Main Scene.png", "#424464")
    const local = await postBackground(page, "Rainy Tavern.png", "#866849", chat.id)
    await admin((api) => api.SetDisplayPrefs({ prefs: { chatBackground: { mediaId: main } } }))
    await page.goto(`${server().url}/chats/${chat.id}`)
    await page.getByLabel("Message", { exact: true }).fill("We approach the tavern.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    const reply = page.getByRole("article", { name: "Reply", exact: true }).last()
    await expect(reply).toContainText(STORY_REPLY)
    await expect(wallpaper(page)).toHaveAttribute("data-chat-wallpaper", main)

    const settings = await openPanel(page, "This chat")
    await settings.getByRole("switch", { name: "Tools", exact: true }).click()
    const background = settings.getByRole("checkbox", { name: /Change the scene background/ })
    await expect(background).not.toBeChecked()
    await background.click()
    await expect(background).toBeChecked()
    await closePanel(page)

    await admin((api) =>
      Effect.gen(function* () {
        const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 2 })
        yield* api.ChangeCast({
          chatId: chat.id,
          slotId: path.leafSlotId,
          forkId: path.forkId,
          change: { _tag: "OutputContract", contract: "final_text" }
        })
      })
    )
    provider.hold(1)
    await page.getByLabel("Message", { exact: true }).fill("We step through the door.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect.poll(provider.heldCount).toBe(1)
    await expect(wallpaper(page)).toHaveAttribute("data-chat-wallpaper", local)
    await expect(page.getByText("Background: Rainy Tavern.png", { exact: true })).toBeVisible()
    provider.release()
    await expect(reply).toContainText("The tavern is quiet tonight.")

    // A fresh swipe has no scene change. Selecting the earlier swipe brings it back.
    calls.length = 0
    await reply.getByRole("button", { name: "Generate another swipe", exact: true }).click()
    await expect(wallpaper(page)).toHaveAttribute("data-chat-wallpaper", main)
    await expect(page.getByText("Background: Rainy Tavern.png", { exact: true })).toHaveCount(0)
    await expect(reply.getByRole("button", { name: "Generate another swipe", exact: true })).toBeEnabled()
    await reply.getByRole("button", { name: "Previous swipe", exact: true }).click()
    await expect(wallpaper(page)).toHaveAttribute("data-chat-wallpaper", local)

    await messageMenu(page.getByRole("article", { name: "Your message", exact: true }).first(), "Branch from here")
    await expect(wallpaper(page)).toHaveAttribute("data-chat-wallpaper", main)
    await page.goBack()
    await expect(wallpaper(page)).toHaveAttribute("data-chat-wallpaper", local)
    const display = await openPanel(page, "Display")
    await expect(display.getByText("Active from scene: Rainy Tavern.png")).toBeVisible()
    const localSettings = display.getByRole("group", { name: "This chat’s background" })
    await localSettings.getByRole("button", { name: "None (solid)" }).click()
    await expect(wallpaper(page)).toHaveCount(0)
    await localSettings.getByRole("button", { name: "Follow scene" }).click()
    await expect(wallpaper(page)).toHaveAttribute("data-chat-wallpaper", local)
  } finally {
    await provider.stop()
  }
})

test("a workshop imports into the main gallery live and Undo takes it back", async ({ page }) => {
  const provider = await startWorkshopProvider({
    calls: [{ name: "set_background", arguments: { file: "/files/moon.png", name: "Moon" } }],
    answer: "The moon background is ready."
  })
  try {
    await setModel(provider.baseUrl)
    await login(page)
    const chat = await admin((api) => api.CreateWorkshop({ title: "Wallpaper workshop" }))
    await admin((api) =>
      api.SetDisplayPrefs({ prefs: { chatBackground: { mediaId: null }, workshopBackground: "inherit" } })
    )
    await filesOf(page.request, server().url).put("/files/moon.png", await png("#686392"))
    await page.goto(`${server().url}/chats/${chat.id}`)
    const settings = await page.context().newPage()
    await settings.goto(`${server().url}/settings/interface`)
    await expect(
      settings.getByRole("group", { name: "Chat background (default)" }).getByRole("button", { name: "None (solid)" })
    ).toHaveAttribute("aria-pressed", "true")
    provider.hold(1)
    await page.getByLabel("Message", { exact: true }).fill("Set the file as my main background.")
    await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
    await expect.poll(provider.heldCount).toBe(1)
    expect(provider.toolResults().join("\n")).toContain("Saved the background.")
    await expect(wallpaper(page)).toHaveCount(1)
    await expect(
      settings.getByRole("group", { name: "Background gallery" }).getByRole("button", { name: "Moon", exact: true })
    ).toHaveAttribute("aria-pressed", "true")
    provider.release()
    await expect(page.getByRole("article").filter({ hasText: "The moon background is ready." })).toBeVisible()
    const changes = await openPanel(page, "Changes")
    await changes.getByRole("button", { name: "Undo", exact: true }).click()
    await expect(wallpaper(page)).toHaveCount(0)
    await expect(settings.getByRole("button", { name: "Moon", exact: true })).toHaveCount(0)
    await settings.close()
  } finally {
    await provider.stop()
  }
})
