// A pending chat (before the first send) has the saved chat's side panel (DESIGN §2.1, owner
// 2026-11-02: it looks and works like any other chat): resizable, with the same tabs; and a
// character added in its Cast tab before the first send is in the chat that send makes.
import { test, expect, type Page } from "@playwright/test"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)

const importCard = (page: Page, name: string, first_mes: string) =>
  page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    data: Buffer.from(JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name, first_mes } })),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })

const setup = async (page: Page) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const existing = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListCards())
  for (const [name, greeting] of [
    ["Panel Wren", "Wren waves."],
    ["Panel Ivo", "Ivo nods."]
  ] as const)
    if (!existing.some((card) => card.name === name)) await importCard(page, name, greeting)
  const cards = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListCards())
  return {
    wren: cards.find((card) => card.name === "Panel Wren")!,
    ivo: cards.find((card) => card.name === "Panel Ivo")!
  }
}

/** Every tab the open panel offers: its tools (with those under More) and its cast strip. */
const tabNames = async (page: Page) => {
  const tools = page.getByRole("tablist", { name: "Chat panel" })
  await expect(tools).toBeVisible()
  const names = await tools.getByRole("tab").allInnerTexts()
  const more = tools.getByRole("button", { name: "More tools" })
  if (await more.isVisible()) {
    await more.click()
    names.push(...(await page.getByRole("menuitem").allInnerTexts()))
    await page.keyboard.press("Escape")
  }
  const cast = await page.getByRole("tablist", { name: "Characters", exact: true }).getByRole("tab").allInnerTexts()
  return [...names.map((name) => name.trim()).sort(), "|", ...cast.map((name) => name.trim())]
}

test("a pending chat's side panel resizes and has the saved chat's tabs", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { wren } = await setup(page)
  await page.goto(`${server().url}/cards/${wren.entityId}/chat`)
  await expect(page.getByRole("article", { name: "Greeting from Panel Wren" })).toBeVisible()
  await openPanel(page, "Cast")
  const pendingTabs = await tabNames(page)
  // Resizable, as the saved chat's panel is.
  const grip = page.getByRole("separator", { name: "Resize chat panel" })
  const panel = page.getByRole("complementary", { name: "Chat panel" })
  const before = (await panel.boundingBox())!.width
  await grip.focus()
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft")
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before + 20)
  // A tab that needs the saved chat says so, in its place.
  await openPanel(page, "Notes")
  await expect(page.getByRole("tabpanel", { name: "Notes" })).toContainText("Available once the chat is saved")
  // The first send saves it in place: the same panel, its tab and its width.
  const width = (await panel.boundingBox())!.width
  await page.getByLabel("Message", { exact: true }).fill("Hello, Wren.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+\?.*panel=notes/)
  await expect(page.getByRole("tabpanel", { name: "Notes" })).not.toContainText("Available once the chat is saved")
  await expect(page.getByRole("tabpanel", { name: "Notes" })).toBeVisible()
  await expect.poll(async () => Math.abs(((await panel.boundingBox())?.width ?? 0) - width)).toBeLessThanOrEqual(1)
  expect(await tabNames(page)).toEqual(pendingTabs)
})

test("a character added in the pending Cast tab is in the chat the first send makes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { wren } = await setup(page)
  await page.goto(`${server().url}/cards/${wren.entityId}/chat`)
  const cast = await openPanel(page, "Cast")
  await cast.getByRole("button", { name: "Add characters" }).click()
  const add = cast.getByRole("button", { name: "Add Panel Ivo to this chat" })
  await add.click()
  await expect(cast.getByRole("listitem", { name: "Panel Ivo" })).toBeVisible()
  await expect(page.getByRole("article", { name: "Greeting from Panel Ivo" })).toBeVisible()
  // The header names both, as the saved chat will be named.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Panel Wren & Panel Ivo")
  // Two characters: who answers first is picked here too.
  await expect(cast.getByLabel("Reply from", { exact: true })).toBeVisible()
  await page.getByLabel("Message", { exact: true }).fill("Hello, both.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+/)
  const saved = page.getByRole("tabpanel", { name: "Cast" })
  await expect(saved.getByRole("listitem", { name: "Panel Ivo" })).toBeVisible()
  await expect(saved.getByRole("listitem", { name: "Panel Wren" })).toBeVisible()
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Panel Wren & Panel Ivo")
})
