// A note or a snippet in the large editor over the chat (owner, 2026-11-02): it stays open in the
// centre column while the side panel moves between characters' definitions, it shares the side
// panel's store (same text, same marker), and the URL restores it on reload and Back/Forward.
// Synthetic cards and text only.
import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test"
import { layoutAudit } from "./support/layoutAudit.ts"
import { openPanel, panelTab } from "./support/panel.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)
let cookie: Promise<string> | null = null
const admin = async <A>(use: Parameters<typeof withCookie<A>>[2]) =>
  withCookie(server(), await (cookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)), use)

/** A chat with two characters, whose definitions the side panel switches between. */
const twoCharacterChat = async () => {
  const wren = await admin((api) => api.CreateCard({ label: "Synthetic Wren", name: "Wren" }))
  const otto = await admin((api) => api.CreateCard({ label: "Synthetic Otto", name: "Otto" }))
  const { chat } = await admin((api) =>
    api.StartChat({
      cards: [wren.entityId, otto.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "A synthetic lighthouse at dusk.", speakerEntityId: null }
    })
  )
  return chat
}

/** The overlay's measured layout findings, inside it only, with crops attached. */
const auditOverlay = async (page: Page, info: TestInfo, overlay: Locator, surface: string) => {
  if (!process.env.LAYOUT_AUDIT) return
  await page.mouse.move(0, 0)
  const box = (await overlay.boundingBox())!
  const findings = (await layoutAudit(page)).filter(
    ({ box: b }) =>
      b.x < box.x + box.width && b.x + b.width > box.x && b.y < box.y + box.height && b.y + b.height > box.y
  )
  for (const [i, finding] of findings.entries()) {
    finding.crop = info.outputPath(`${surface}-${i}-${finding.kind}.png`)
    await page.screenshot({ path: finding.crop, clip: finding.box })
    await info.attach(`${surface}-${i}`, { path: finding.crop, contentType: "image/png" })
  }
  await info.attach(surface, { body: JSON.stringify(findings, null, 2), contentType: "application/json" })
  const shot = info.outputPath(`${surface}.png`)
  await page.screenshot({ path: shot })
  await info.attach(`${surface}-page`, { path: shot, contentType: "image/png" })
  expect.soft(findings, `${surface} layout`).toEqual([])
}

/** Edits a character's Description in the side panel, which leaves the large editor open. */
const editDefinition = async (page: Page, name: string, text: string) => {
  await panelTab(page, name)
  const tab = page.getByRole("tabpanel", { name })
  const field = tab.getByRole("textbox", { name: "Description", exact: true })
  await field.fill(text)
  await expectTextBox(field, text)
}

test.describe("wide", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  })

  test("a note open large stays while the panel moves between characters", async ({ page }, info) => {
    const chat = await twoCharacterChat()
    await admin((api) => api.CreateChatNote({ chatId: chat.id, title: "Tide table" }))
    await page.goto(`${server().url}/chats/${chat.id}`)
    const notes = await openPanel(page, "Notes")
    await notes.getByRole("button", { name: "Actions for Tide table", exact: true }).click()
    await page.getByRole("menuitem", { name: "Large editor", exact: true }).click()
    const overlay = page.getByRole("region", { name: "Note editor" })
    await expect(overlay).toBeVisible()
    await expect(page).toHaveURL(/\/library\/.*focus=note/)
    // Opening it is a place: Back closes it, Forward opens it again.
    await page.goBack()
    await expect(overlay).toHaveCount(0)
    await page.goForward()
    await expect(overlay).toBeVisible()
    const large = overlay.getByRole("textbox", { name: "Text of Tide table" })
    await large.fill("High water at six.")
    // The side panel's copy is the same store: the same text and marker.
    await expectTextBox(notes.getByRole("textbox", { name: "Text of Tide table" }), "High water at six.")
    await expect(overlay.getByText("edited", { exact: true })).toBeVisible()

    await editDefinition(page, "Wren", "Wren keeps the lamp.")
    await expect(overlay).toBeVisible()
    await large.click()
    await large.press("End")
    await large.pressSequentially(" Low at noon.")
    await editDefinition(page, "Otto", "Otto mends the nets.")
    await expectTextBox(large, "High water at six. Low at noon.")
    await panelTab(page, "Wren")
    await expectTextBox(
      page.getByRole("tabpanel", { name: "Wren" }).getByRole("textbox", { name: "Description", exact: true }),
      "Wren keeps the lamp."
    )
    await auditOverlay(page, info, overlay, "note-1440")

    // Reload restores it, with its text.
    await expect(page.locator("[data-keeping=true]")).toHaveCount(0)
    await page.reload()
    await expect(overlay).toBeVisible()
    await expectTextBox(overlay.getByRole("textbox", { name: "Text of Tide table" }), "High water at six. Low at noon.")
    await overlay.getByRole("button", { name: "Close", exact: true }).click()
    await expect(overlay).toHaveCount(0)
    await expect(page).not.toHaveURL(/\/library\//)
  })

  test("a snippet open large stays while the panel moves between characters", async ({ page }, info) => {
    const chat = await twoCharacterChat()
    await admin((api) => api.CreateSnippet({ chatId: chat.id, title: "Lighthouse lines", content: "" }))
    await page.goto(`${server().url}/chats/${chat.id}`)
    const snippets = await openPanel(page, "Snippets")
    await snippets.getByRole("button", { name: "Open Lighthouse lines in the large editor", exact: true }).click()
    const overlay = page.getByRole("region", { name: "Snippet editor" })
    await expect(overlay).toBeVisible()
    const large = overlay.getByRole("textbox", { name: "Text of Lighthouse lines" })
    await large.fill("The beam sweeps the bay.")
    await expect(overlay.getByText("edited", { exact: true })).toBeVisible()
    // Its own editor offers no sending to itself.
    await expect(overlay.getByRole("button", { name: "Send text to snippet" })).toHaveCount(0)
    await expectTextBox(snippets.getByRole("textbox", { name: "Text of Lighthouse lines" }), "The beam sweeps the bay.")

    await editDefinition(page, "Wren", "Wren climbs the stair.")
    await expect(overlay).toBeVisible()
    await large.click()
    await large.press("End")
    await large.pressSequentially(" Ships turn home.")
    await editDefinition(page, "Otto", "Otto counts the boats.")
    await expectTextBox(large, "The beam sweeps the bay. Ships turn home.")
    await panelTab(page, "Wren")
    await expectTextBox(
      page.getByRole("tabpanel", { name: "Wren" }).getByRole("textbox", { name: "Description", exact: true }),
      "Wren climbs the stair."
    )
    await auditOverlay(page, info, overlay, "snippet-1440")

    // Save in the large editor saves the panel's copy too.
    await overlay.getByRole("button", { name: "Save", exact: true }).click()
    await expect(overlay.getByText("edited", { exact: true })).toHaveCount(0)
    await openPanel(page, "Snippets")
    await expect(snippets.getByText("edited", { exact: true })).toHaveCount(0)

    await page.reload()
    await expect(overlay).toBeVisible()
    await expectTextBox(
      overlay.getByRole("textbox", { name: "Text of Lighthouse lines" }),
      "The beam sweeps the bay. Ships turn home."
    )
  })
})

for (const width of [1920, 390])
  test(`the large note and snippet at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const chat = await twoCharacterChat()
    await admin((api) => api.CreateChatNote({ chatId: chat.id, title: "Harbour log" }))
    await admin((api) => api.CreateSnippet({ chatId: chat.id, title: "Keeper lines", content: "A quiet watch." }))
    await page.goto(`${server().url}/chats/${chat.id}`)
    const notes = await openPanel(page, "Notes")
    await notes.getByRole("button", { name: "Actions for Harbour log", exact: true }).click()
    await page.getByRole("menuitem", { name: "Large editor", exact: true }).click()
    const note = page.getByRole("region", { name: "Note editor" })
    await expect(note).toBeVisible()
    await note.getByRole("textbox", { name: "Text of Harbour log" }).fill("Calm seas.")
    await auditOverlay(page, info, note, `note-${width}`)
    await note.getByRole("button", { name: "Close", exact: true }).click()
    const snippets = await openPanel(page, "Snippets")
    await snippets.getByRole("button", { name: "Open Keeper lines in the large editor", exact: true }).click()
    const snippet = page.getByRole("region", { name: "Snippet editor" })
    await expect(snippet).toBeVisible()
    await expectTextBox(snippet.getByRole("textbox", { name: "Text of Keeper lines" }), "A quiet watch.")
    await auditOverlay(page, info, snippet, `snippet-${width}`)
    await page.reload()
    await expect(snippet).toBeVisible()
  })

test("outside a chat, a snippet opens large on its library page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const made = await admin((api) => api.CreateSnippet({ chatId: null, title: "Shore notes", content: "Gulls." }))
  await page.goto(`${server().url}/library/${made.ref.id}?focus=snippet`)
  const view = page.getByRole("region", { name: "Snippet Shore notes" })
  const text = view.getByRole("textbox", { name: "Text of Shore notes" })
  await expectTextBox(text, "Gulls.")
  await expect(view.getByRole("switch", { name: "All chats" })).toBeChecked()
  await text.click()
  await text.press("End")
  await text.pressSequentially(" Terns.")
  await expect(view.getByText("edited", { exact: true })).toBeVisible()
  await expect(page.locator("[data-keeping=true]")).toHaveCount(0)
  await page.reload()
  await expectTextBox(view.getByRole("textbox", { name: "Text of Shore notes" }), "Gulls. Terns.")
})

test("text sent from a card's definitions lands in the snippet open large", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chat = await twoCharacterChat()
  await admin((api) => api.CreateSnippet({ chatId: chat.id, title: "Beacon log", content: "First light." }))
  await admin((api) => api.CreateSnippet({ chatId: chat.id, title: "Other log", content: "Elsewhere." }))
  await page.goto(`${server().url}/chats/${chat.id}`)
  const snippets = await openPanel(page, "Snippets")
  await snippets.getByRole("button", { name: "Open Beacon log in the large editor", exact: true }).click()
  const overlay = page.getByRole("region", { name: "Snippet editor" })
  await expect(overlay.getByRole("textbox", { name: "Text of Beacon log" })).toBeVisible()
  await panelTab(page, "Wren")
  const field = page.getByRole("tabpanel", { name: "Wren" }).getByRole("textbox", { name: "Description", exact: true })
  await field.fill("Wren lights the beacon.")
  await page
    .getByRole("tabpanel", { name: "Wren" })
    .getByRole("button", { name: "Send text to snippet", exact: true })
    .first()
    .click()
  await expectTextBox(
    overlay.getByRole("textbox", { name: "Text of Beacon log" }),
    "First light.\n\nWren lights the beacon."
  )
  await expect(field).toBeFocused()
  const other = (await admin((api) => api.ListSnippets({ chatId: chat.id }))).find((s) => s.title === "Other log")
  expect(other?.content).toBe("Elsewhere.")
})
