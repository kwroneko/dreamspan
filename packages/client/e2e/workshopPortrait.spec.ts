import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import sharp from "sharp"
import type { RefId } from "@dreamspan/shared/library.ts"
import { avatarCropOf } from "@dreamspan/shared/media.ts"
import { asPage, asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startWorkshopProvider } from "./support/workshopProvider.ts"

test.describe("workshop portraits", () => {
  const server = serverPerFile(withAdmin)
  const answer = "Portrait change complete."
  let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
  test.beforeAll(async () => {
    provider = await startWorkshopProvider({
      answer,
      perTask: true,
      calls: [
        {
          name: "edit_card",
          arguments: (body) =>
            JSON.stringify(body.messages).includes("versioned portrait")
              ? { card: "Versioned Portrait", portrait: "/files/versioned.png" }
              : {
                  card: "Portrait Review",
                  portrait: "/files/replacement.png",
                  changes: [{ field: "description", text: "Updated." }]
                }
        }
      ]
    })
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Synthetic workshop",
            baseUrl: provider.baseUrl,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null,
            providerSettings: { toolLoading: "every" }
          }
        })
        const model = yield* api.AddUserModel({ connectionId: connection.id, key: "workshop-small", overrides: {} })
        yield* api.SetGenerationDefaults({
          defaults: { model: { connection: connection.id, model: model.id }, preset: null }
        })
      })
    )
  })
  test.afterAll(async () => {
    await provider?.stop()
  })
  const picture = (background: string) =>
    sharp({ create: { width: 80, height: 120, channels: 3, background } })
      .png()
      .toBuffer()
  const post = (page: Page, path: string, data: Buffer) =>
    page.request.post(`${server().url}${path}`, {
      data,
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })

  const importCard = async (page: Page, name: string) => {
    const card = await post(
      page,
      "/library/import?name=card.json",
      Buffer.from(
        JSON.stringify({
          spec: "chara_card_v3",
          spec_version: "3.0",
          data: {
            name,
            description: "Synthetic.",
            personality: "",
            scenario: "",
            first_mes: "",
            mes_example: "",
            creator_notes: "",
            system_prompt: "",
            post_history_instructions: "",
            alternate_greetings: [],
            tags: [],
            creator: "",
            character_version: "",
            extensions: {}
          }
        })
      )
    )
    expect(card.status(), await card.text()).toBe(200)
    return (await card.json()).library.ref as { id: RefId; rowVersion: number }
  }
  const askForPortrait = async (page: Page, task: string) => {
    const workshop = await asPage(page, server(), (api) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateWorkshop({ title: "Portrait review" })
        yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.cards", mode: "allow" })
        return chat
      })
    )
    await page.goto(`${server().url}/chats/${workshop.id}`)
    await page.getByLabel("Message", { exact: true }).fill(task)
    await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
    await expect(page.getByRole("article").filter({ hasText: answer })).toHaveCount(1, { timeout: 30_000 })
    expect(provider.toolResults().at(-1)).toContain("revision")
  }

  test("Keep now keeps the later visible portrait cutout", async ({ page }) => {
    test.setTimeout(90_000)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const ref = await importCard(page, "Portrait Review")
    const oldPicture = await post(
      page,
      `/library/avatar?ref=${ref.id}&rowVersion=${ref.rowVersion}&crop=1000_1000_8000_8000`,
      await picture("red")
    )
    expect(oldPicture.status(), await oldPicture.text()).toBe(200)
    const replacement = await post(page, "/files/upload?path=%2Ffiles%2Freplacement.png", await picture("blue"))
    expect(replacement.status(), await replacement.text()).toBe(200)
    const open = () => asPage(page, server(), (api) => api.OpenEditor({ refId: ref.id }))
    const before = await open()
    expect(avatarCropOf(before.doc.avatar_media_id, before.doc.avatar_crop)).not.toBeNull()
    await askForPortrait(page, "Set the replacement portrait.")

    const edited = await open()
    expect(edited.doc.avatar_media_id).not.toBe(before.doc.avatar_media_id)
    expect(edited.doc.avatar_crop).toBeUndefined()
    const cutout = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 }
    await asPage(page, server(), (api) =>
      api.SetCardAvatarCrop({
        refId: ref.id,
        expectedRowVersion: edited.ref.rowVersion,
        crop: cutout
      })
    )
    const cropped = await open()
    expect(avatarCropOf(cropped.doc.avatar_media_id, cropped.doc.avatar_crop)).toEqual(cutout)

    await page.locator(`[data-change-row="${ref.id}"]`).getByRole("button", { name: "Revert", exact: true }).click()
    const conflict = page.locator("[data-conflict]").filter({ has: page.getByRole("button", { name: "Keep now" }) })
    await expect(conflict).toHaveCount(1)
    await expect(conflict.getByRole("button", { name: "Keep now" })).toHaveAttribute("aria-pressed", "true")
    await conflict.getByRole("button", { name: "Keep now" }).click()
    await page.getByRole("button", { name: "Revert the rest", exact: true }).click()
    await expect.poll(async () => (await open()).ref.rowVersion).toBeGreaterThan(cropped.ref.rowVersion)
    const reverted = await open()
    expect(reverted.doc.avatar_media_id).toBe(edited.doc.avatar_media_id)
    expect(reverted.doc.description).toBe(before.doc.description)
    expect(avatarCropOf(reverted.doc.avatar_media_id, reverted.doc.avatar_crop)).toEqual(cutout)

    await expect(page.getByRole("heading", { name: "Portrait Review · changes" })).toBeVisible()
    const portrait = page
      .getByLabel("What changed", { exact: true })
      .locator("details")
      .filter({ hasText: /^Portrait/ })
    await expect(portrait).toHaveCount(1)
    await portrait.getByRole("button", { name: "Revert this field" }).click()
    const choices = page.getByRole("group", { name: "What to do with Portrait" })
    await choices.getByRole("button", { name: "Take before" }).click()
    await page.getByRole("button", { name: "Revert the rest", exact: true }).click()
    await expect.poll(async () => (await open()).doc.avatar_media_id).toBe(before.doc.avatar_media_id)
    const restored = await open()
    expect(avatarCropOf(restored.doc.avatar_media_id, restored.doc.avatar_crop)).toEqual(
      avatarCropOf(before.doc.avatar_media_id, before.doc.avatar_crop)
    )
    await portrait.getByRole("button", { name: "Redo", exact: true }).click()
    await expect.poll(async () => (await open()).doc.avatar_media_id).toBe(edited.doc.avatar_media_id)
    const redone = await open()
    expect(avatarCropOf(redone.doc.avatar_media_id, redone.doc.avatar_crop)).toEqual(cutout)
    expect(redone.doc.description).toBe(before.doc.description)
  })

  test("an image already in file history renders as a portrait", async ({ page }) => {
    test.setTimeout(90_000)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const ref = await importCard(page, "Versioned Portrait")
    const green = await picture("green")
    const queued = await post(page, "/files/upload?path=%2Ffiles%2Fqueued.png", green)
    expect(queued.status(), await queued.text()).toBe(200)
    const replaced = await post(page, "/files/upload?path=%2Ffiles%2Fqueued.png&conflict=replace", await picture("red"))
    expect(replaced.status(), await replaced.text()).toBe(200)
    const replacement = await post(page, "/files/upload?path=%2Ffiles%2Fversioned.png", green)
    expect(replacement.status(), await replacement.text()).toBe(200)

    const usage = () => asPage(page, server(), (api) => api.GetFilesUsage({ fresh: true }))
    const before = await usage()
    await askForPortrait(page, "Set the versioned portrait.")
    expect((await usage()).versionsBytes).toBe(before.versionsBytes)
    const saved = await asPage(page, server(), (api) => api.OpenEditor({ refId: ref.id }))
    const mediaId = saved.doc.avatar_media_id
    expect(typeof mediaId).toBe("string")
    const row = page.locator(`[data-change-row="${ref.id}"]`)
    await expect(row).toBeVisible()
    const image = row.locator("[data-portrait] img")
    await expect(image).toHaveAttribute("src", new RegExp(`id=${mediaId}(&|$)`))
    await image.scrollIntoViewIfNeeded()
    const url = new URL((await image.getAttribute("src"))!, server().url)
    const response = await page.request.get(url.href)
    expect(response.status(), await response.text()).toBe(200)
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0)
  })
})
