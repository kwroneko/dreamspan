// The chat header's rename in place has Save and Cancel right after the field: Save keeps
// the typed name, Cancel restores the old one, Enter and Escape still do the same, and opening
// the field neither changes the header's height nor pushes its buttons out of view.
import { mkdirSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const shots = process.env.SHOTS_DIR
let chatId = ""
test.beforeAll(async () => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Wren", name: "Wren" })
      const started = yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "The lamp is lit.", speakerEntityId: card.entityId }
      })
      chatId = started.chat.id
    })
  )
})

for (const width of [1340, 600, 390])
  test(`${width} dark: the chat title's rename has Save and Cancel and keeps the header's height`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chatId}`)
    // The name is a heading, or the field while renaming.
    const named = page
      .getByRole("heading", { level: 1 })
      .or(page.getByRole("textbox", { name: "Chat name", exact: true }))
    const header = page.locator("main header").filter({ has: named })
    const title = header.getByRole("heading", { level: 1 }).getByRole("button")
    await expect(title).toBeVisible()
    await expect(page.getByRole("status").filter({ hasText: /^(Loading|Still loading)/ })).toHaveCount(0)
    const before = (await header.boundingBox())!
    const field = header.getByRole("textbox", { name: "Chat name", exact: true })
    const save = header.getByRole("button", { name: "Save the name", exact: true })
    const cancel = header.getByRole("button", { name: "Cancel renaming", exact: true })
    const original = (await title.textContent())!.trim()
    const buttons = await header.getByRole("button").evaluateAll((all) => all.map((b) => b.getAttribute("aria-label")))

    // Cancel restores the name.
    await title.click()
    await expect(field).toBeVisible()
    await expect(save).toBeVisible()
    await expect(cancel).toBeVisible()
    expect((await header.boundingBox())!.height).toBe(before.height)
    const viewport = page.viewportSize()!
    for (const button of await header.getByRole("button").all()) {
      const box = (await button.boundingBox())!
      expect(box.x + box.width, (await button.getAttribute("aria-label")) ?? "").toBeLessThanOrEqual(viewport.width)
    }
    const fieldBox = (await field.boundingBox())!
    const saveBox = (await save.boundingBox())!
    expect(saveBox.x - (fieldBox.x + fieldBox.width)).toBeLessThanOrEqual(8)
    // A narrow header gives the field the branch's and the buttons' room.
    if (before.width < 640) expect(fieldBox.width).toBeGreaterThanOrEqual(before.width * 0.6)
    await field.fill("Unwanted name")
    await save.hover()
    await expect(page.getByText("Save the name (Enter)", { exact: true }).filter({ visible: true })).toBeVisible()
    await expectLayout(page, info, `chat title editing ${width}`, { scope: "main header", hovered: true })
    if (shots) {
      mkdirSync(shots, { recursive: true })
      await page.screenshot({ path: `${shots}/editing-${width}-dark.png`, clip: { ...before, y: 0, height: 120 } })
    }
    await cancel.hover()
    await expect(page.getByText("Cancel (Escape)", { exact: true }).filter({ visible: true })).toBeVisible()
    await cancel.click()
    await expect(field).toHaveCount(0)
    await expect(title).toHaveText(original)
    // The branch and the buttons are back.
    for (const label of buttons)
      if (label) await expect(header.getByRole("button", { name: label, exact: true })).toBeVisible()
    expect((await header.boundingBox())!.height).toBe(before.height)

    // Save keeps the typed name.
    await title.click()
    await field.fill(`Lamp night ${width}`)
    await save.click()
    await expect(field).toHaveCount(0)
    await expect(title).toHaveText(`Lamp night ${width}`)
    await page.reload()
    await expect(title).toHaveText(`Lamp night ${width}`)

    // Enter and Escape still work.
    await title.click()
    await field.fill("Escaped")
    await field.press("Escape")
    await expect(title).toHaveText(`Lamp night ${width}`)
    await title.click()
    await field.fill(`Entered ${width}`)
    await field.press("Enter")
    await expect(title).toHaveText(`Entered ${width}`)
  })

test("rename handles focus leaving its actions and guards a pending save", async ({ page }) => {
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.CreateChat({ title: "Original" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const held: { release?: () => void } = {}
  let renames = 0
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      if (typeof data === "string" && JSON.parse(data).tag === "RenameChat" && ++renames === 2)
        held.release = () => upstream.send(data)
      else upstream.send(data)
    })
  })
  await page.goto(`${server().url}/chats/${chat.id}`)
  const title = page.getByRole("heading", { level: 1 }).getByRole("button")
  const field = page.getByRole("textbox", { name: "Chat name", exact: true })
  const save = page.getByRole("button", { name: "Save the name" })
  const cancel = page.getByRole("button", { name: "Cancel renaming" })

  await title.click()
  await field.fill("Escaped from Save")
  await field.press("Tab")
  await expect(save).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(title).toHaveText("Original")

  await title.click()
  await field.fill("Saved on blur")
  await field.press("Tab")
  await page.keyboard.press("Tab")
  await expect(cancel).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(title).toHaveText("Saved on blur")

  await title.click()
  await field.fill("Submitted")
  await save.click()
  try {
    await expect.poll(() => held.release !== undefined).toBe(true)
    await expect(cancel).toBeDisabled()
    await field.press("Escape")
    await expect(field).toHaveValue("Submitted")
    await field.press("Tab")
    await expect(field).toBeVisible()
  } finally {
    held.release?.()
  }
  await expect(title).toHaveText("Submitted")
  expect(renames).toBe(2)
})

test("a phone chat title matching a switch label leaves its controls visible", async ({ page }) => {
  const label = "Summarize older messages"
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.CreateChat({ title: label }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${server().url}/chats/${chat.id}`)
  const tab = await openPanel(page, "This chat")
  await expect(tab.getByRole("heading", { name: label, exact: true })).toHaveClass("sr-only")
  const summaries = tab.getByRole("region", { name: "Summaries", exact: true })
  await expect(summaries.getByRole("switch", { name: label })).toBeVisible()
  await expect(summaries.locator(".sr-only")).toHaveCount(0)
  await summaries.getByRole("button", { name: "Summaries", exact: true }).click()
  await expect(page.getByRole("tabpanel", { name: "Summaries", exact: true })).toBeVisible()
})
