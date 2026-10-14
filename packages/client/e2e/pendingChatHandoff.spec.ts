import { test, expect, type Page } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "60", FAKE_GENERATOR_TOKENS: "1200" })
const copies = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Array<{ content: string; save: { kind: string; payload: { chatId?: string } } }>>((resolve) => {
        const request = indexedDB.open("rp-editor-copies", 1)
        request.onsuccess = () => {
          const db = request.result
          const all = db.transaction("copies").objectStore("copies").getAll()
          all.onsuccess = () => {
            db.close()
            resolve(all.result)
          }
        }
      })
  )

const setup = async (page: Page, title: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const existing = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListCards())
  for (const name of ["Handoff Mira", "Tobias Wren"]) {
    if (existing.some((card) => card.name === name)) continue
    await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
      data: Buffer.from(
        JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name, first_mes: "Welcome." } })
      ),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
  }
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const cards = (yield* api.ListCards()).filter((c) => ["Handoff Mira", "Tobias Wren"].includes(c.name))
      const chat = yield* api.CreateChat({ title })
      for (const entityId of cards.map((c) => c.entityId))
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId } })
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "First turn." })
      return chat
    })
  )
  await page.goto(`${server().url}/groups/${chat.id}/new`)
  await expect(page.getByRole("article", { name: "Greeting" })).toBeVisible()
  return chat
}

test("a group's pending chat accepts the group's full existing title", async ({ page }) => {
  const title = "An existing group " + "x".repeat(200)
  await page.setViewportSize({ width: 1440, height: 900 })
  await setup(page, title)
  await page.screenshot({ path: test.info().outputPath("desktop-long-group-pending.png") })
  await page.getByLabel("Message", { exact: true }).fill("Please start this group chat.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+$/, { timeout: 5000 })
  const groups = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListChatGroups())
  const group = groups.find((group) => group.name === title)!
  expect(group.chats).toBe(2)
  expect(group.latestChatId).toBe(page.url().split("/").at(-1))
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
  await page.screenshot({ path: test.info().outputPath("phone-long-group-saved.png") })
})

for (const target of ["group", "card"] as const) {
  test(`${target}: text typed during the first send survives reload before the new composer opens`, async ({
    page
  }) => {
    let releaseStart: (() => void) | null = null
    let composerHeld = false
    let holdComposer = true
    let holdSave = true
    let saveHeld = false
    await page.routeWebSocket("**/rpc", (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((message) => {
        const text = String(message)
        if (releaseStart === null && text.includes('"tag":"StartChat"')) releaseStart = () => upstream.send(message)
        else if (holdComposer && text.includes('"tag":"OpenComposer"')) composerHeld = true
        else if (holdSave && text.includes('"tag":"SaveComposer"')) saveHeld = true
        else upstream.send(message)
      })
      upstream.onMessage((message) => socket.send(message))
    })
    await setup(page, "Draft handoff")
    if (target === "card") {
      const cards = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListCards())
      await page.goto(`${server().url}/cards/${cards.find((c) => c.name === "Tobias Wren")!.entityId}/chat`)
      await expect(page.getByRole("article", { name: "Greeting" })).toBeVisible()
    }
    const composer = page.getByLabel("Message", { exact: true })
    await composer.fill("The first message that will be saved.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect.poll(() => releaseStart !== null).toBe(true)
    await composer.fill("Irreplaceable text typed while the first send was pending.")
    releaseStart!()
    await expect(page).toHaveURL(/\/chats\/[^/?]+$/)
    await expect.poll(() => composerHeld).toBe(true)
    const chatId = page.url().split("/").at(-1)!
    await expect
      .poll(async () =>
        (await copies(page)).some(
          (copy) =>
            copy.content === "Irreplaceable text typed while the first send was pending." &&
            copy.save.payload.chatId === chatId
        )
      )
      .toBe(true)
    holdComposer = false
    await page.reload()
    // The destination has adopted a durable draft copy, but its save is still held.
    await expect.poll(() => saveHeld).toBe(true)
    await expect
      .poll(async () =>
        (await copies(page)).some(
          (copy) =>
            copy.save.kind === "composer" &&
            copy.content === "Irreplaceable text typed while the first send was pending."
        )
      )
      .toBe(true)
    holdSave = false
    await page.reload()
    await expect(composer).toHaveValue("Irreplaceable text typed while the first send was pending.")
    await expect.poll(() => copies(page)).toEqual([])
    await expect(page.getByRole("article", { name: "Your message", exact: true })).toContainText(
      "The first message that will be saved."
    )
    const recovered = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.ListRecoveredTexts({ limit: 100, before: null })
    )
    expect(recovered.map((text) => text.content)).not.toContain("The first message that will be saved.")
    await page.screenshot({ path: test.info().outputPath(`${target}-handoff-restored.png`) })
  })
}

test("a phone shows the full streaming speaker name and Stop", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page, "Lantern Inn")
  const cards = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListCards())
  await page.goto(`${server().url}/cards/${cards.find((c) => c.name === "Tobias Wren")!.entityId}/chat`)
  await page.getByLabel("Message", { exact: true }).fill("Tell a story.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+$/)
  const reply = page.getByRole("article", { name: "Reply", exact: true }).last()
  await expect(reply.getByText("generating", { exact: true })).toBeVisible()
  await expect(reply.getByRole("button", { name: "Stop", exact: true })).toBeInViewport()
  const speaker = reply.locator("header").getByText("Tobias Wren", { exact: true })
  await expect(speaker).toBeVisible()
  expect(await speaker.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath("phone-streaming.png") })
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(speaker).toBeVisible()
  await expect(reply.getByRole("button", { name: "Stop", exact: true })).toBeInViewport()
  await page.screenshot({ path: test.info().outputPath("desktop-streaming.png") })
})
