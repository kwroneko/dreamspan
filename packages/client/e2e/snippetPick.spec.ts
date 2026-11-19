// Synthetic text only. Where "Send text to snippet" goes (owner, 2026-11-02): one click adds to the
// snippet expanded in a shown Snippets panel, the one opened, clicked or typed into last, marked on
// its header; with none shown, on a phone, or on a right-click, a menu at the button chooses one.
import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { closePanel, openPanel, panelTab } from "./support/panel.ts"
import { expectTextBox, textBoxValue } from "./support/textbox.ts"
import { layoutAudit } from "./support/layoutAudit.ts"

const server = serverPerFile(withAdmin)
let cookie: Promise<string> | null = null
const admin = async <A>(use: Parameters<typeof withCookie<A>>[2]) =>
  withCookie(server(), await (cookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)), use)

const block = (scope: Locator, title: string) => scope.getByRole("region", { name: `Snippet ${title}` })
const snippetText = (scope: Locator, title: string) =>
  block(scope, title).getByRole("textbox", { name: `Text of ${title}` })
const menu = (page: Page) => page.getByRole("menu", { name: /to snippet$/ })
const menuItem = (page: Page, name: string) => menu(page).getByRole("menuitem", { name: new RegExp(`^${name}`) })

/** A chat with one message of the user's and three named snippets; the message opened for editing. */
const setup = async (page: Page, width: number, snippets = ["Alpha", "Bravo", "Charlie"]) => {
  await page.setViewportSize({ width, height: 1000 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const old of await admin((api) => api.ListSnippets({ chatId: null })))
    await admin((api) => api.DeleteNote({ noteRefId: old.ref.id }))
  const chat = await admin((api) => api.CreateChat({ title: "Harbour pick" }))
  const chatId = chat.id as ChatId
  await admin((api) =>
    api.SendMessage({ chatId, forkId: null, parentSlotId: null, branch: false, content: "A gull crosses the bay." })
  )
  for (const title of snippets) await admin((api) => api.CreateSnippet({ chatId, title, content: `${title} notes.` }))
  await page.goto(`${server().url}/chats/${chat.id}`)
  return chatId
}

const editMessage = async (page: Page) => {
  const mine = page.getByRole("article", { name: "Your message" })
  await mine.locator(".markdown").dblclick({ position: { x: 24, y: 12 } })
  const editor = mine.getByRole("textbox", { name: "Message text" })
  await expect(editor).toBeFocused()
  return { mine, editor, sendText: mine.getByRole("button", { name: "Send text to snippet", exact: true }) }
}

const content = async (chatId: ChatId, title: string) =>
  (await admin((api) => api.ListSnippets({ chatId }))).find((s) => s.title === title)?.content

/** The layout audit (LAYOUT_AUDIT=1) on what's around `scope`, with crops of any finding. */
const audit = async (page: Page, info: TestInfo, scope: Locator, surface: string) => {
  if (!process.env.LAYOUT_AUDIT) return
  const box = (await scope.boundingBox())!
  const findings = (await layoutAudit(page)).filter(
    ({ box: b }) =>
      b.x < box.x + box.width && b.x + b.width > box.x && b.y < box.y + box.height && b.y + b.height > box.y
  )
  for (const [i, finding] of findings.entries()) {
    finding.crop = info.outputPath(`${surface}-${i}-${finding.kind}.png`)
    await page.screenshot({ path: finding.crop, clip: finding.box })
  }
  await info.attach(surface, { body: JSON.stringify(findings, null, 2), contentType: "application/json" })
  await page.screenshot({ path: info.outputPath(`${surface}.png`) })
  expect.soft(findings, `${surface} layout`).toEqual([])
}

test("one click adds to the snippet used last that's still expanded, marked on its header", async ({ page }, info) => {
  const chatId = await setup(page, 1440)
  const panel = await openPanel(page, "Snippets")
  for (const title of ["Alpha", "Bravo", "Charlie"]) await expect(snippetText(panel, title)).toBeVisible()
  // Alpha, Bravo, Charlie used in that order; Charlie and Bravo closed: Alpha is the target.
  for (const title of ["Alpha", "Bravo", "Charlie"]) await snippetText(panel, title).click()
  await expect(block(panel, "Charlie").locator("[data-snippet-target]")).toHaveCount(1)
  await block(panel, "Charlie").getByRole("button", { name: "Collapse Charlie" }).click()
  await block(panel, "Bravo").getByRole("button", { name: "Collapse Bravo" }).click()
  await expect(block(panel, "Alpha").locator("[data-snippet-target]")).toHaveCount(1)
  await expect(panel.locator("[data-snippet-target]")).toHaveCount(1)
  const dot = block(panel, "Alpha").locator("[data-snippet-target]")
  await dot.hover()
  await expect(
    page
      .getByText('This snippet is currently the default destination for "Send text to snippet" actions.', {
        exact: true
      })
      .last()
  ).toBeVisible()

  const { mine, editor, sendText } = await editMessage(page)
  await sendText.hover()
  await expect(page.getByText("Adds this text to “Alpha”.", { exact: false }).last()).toBeVisible()
  await sendText.click()
  await expect(menu(page)).toHaveCount(0)
  await expectTextBox(snippetText(panel, "Alpha"), "Alpha notes.\n\nA gull crosses the bay.")
  // Shown where it landed, briefly marked, with no notice; the message editor keeps focus.
  await expect(block(panel, "Alpha").locator(".rp-flash")).toHaveText("A gull crosses the bay.")
  await expect(page.locator("[data-toast]").filter({ hasText: "Added to" })).toHaveCount(0)
  await expect(editor).toBeFocused()
  await expect.poll(() => content(chatId, "Alpha")).toBe("Alpha notes.\n\nA gull crosses the bay.")
  await audit(page, info, mine, "strip-1440")
  await expect(block(panel, "Alpha").locator(".rp-flash")).toHaveCount(0)

  // Two expanded: a click into the other moves the target and its marker.
  await block(panel, "Bravo").getByRole("button", { name: "Expand Bravo" }).click()
  await snippetText(panel, "Bravo").click()
  await expect(block(panel, "Bravo").locator("[data-snippet-target]")).toHaveCount(1)
  await expect(block(panel, "Alpha").locator("[data-snippet-target]")).toHaveCount(0)
  await editor.focus()
  await editor.press("Control+End")
  await editor.press("Shift+Home")
  // The selection's button comes without moving the whole text's.
  const before = (await sendText.boundingBox())!
  const sendSelection = mine.getByRole("button", { name: "Send selection to snippet", exact: true })
  await expect(sendSelection).toBeVisible()
  expect(await sendText.boundingBox()).toEqual(before)
  expect((await sendSelection.boundingBox())!.x).toBeLessThan(before.x)
  await sendSelection.click()
  await expect.poll(() => textBoxValue(snippetText(panel, "Bravo"))).toBe("Bravo notes.\n\nA gull crosses the bay.")
  await expect(editor).toBeFocused()
  // The shortcut follows the same rule.
  await editor.press("Control+Shift+S")
  await expect
    .poll(() => textBoxValue(snippetText(panel, "Bravo")))
    .toBe("Bravo notes.\n\nA gull crosses the bay.\n\nA gull crosses the bay.")
  expect(await content(chatId, "Alpha")).toBe("Alpha notes.\n\nA gull crosses the bay.")

  // A right-click chooses even with a target; focus comes back to the message.
  await sendText.click({ button: "right" })
  await expect(menu(page)).toBeVisible()
  await audit(page, info, menu(page), "menu-1440")
  await menuItem(page, "Charlie").click()
  await expect(page.getByText("Added to snippet “Charlie”", { exact: true })).toBeVisible()
  await expect(editor).toBeFocused()
  await expect.poll(() => content(chatId, "Charlie")).toBe("Charlie notes.\n\nA gull crosses the bay.")
  // The one picked last comes first in the menu, New snippet last.
  await sendText.click({ button: "right" })
  const items = menu(page).getByRole("menuitem")
  await expect(items.first()).toHaveText(/^Charlie/)
  await expect(items.last()).toHaveText(/^New snippet/)
  await page.keyboard.press("Escape")
  await expect(editor).toBeFocused()
})

test("with Snippets hidden the menu chooses, leaving the panel as it is", async ({ page }) => {
  const chatId = await setup(page, 1440)
  const panel = await openPanel(page, "Snippets")
  await snippetText(panel, "Alpha").click()
  await panelTab(page, "Notes")
  const { editor, sendText } = await editMessage(page)
  await sendText.hover()
  await expect(page.getByText("Choose a snippet to add this text to.", { exact: false }).last()).toBeVisible()
  await sendText.click()
  await expect(menu(page)).toBeVisible()
  await menuItem(page, "Bravo").click()
  await expect(page.getByText("Added to snippet “Bravo”", { exact: true })).toBeVisible()
  await expect(page.getByRole("tabpanel", { name: "Notes" })).toBeVisible()
  await expect(page.getByRole("tabpanel", { name: "Snippets" })).toBeHidden()
  await expect(editor).toBeFocused()
  await expect.poll(() => content(chatId, "Bravo")).toBe("Bravo notes.\n\nA gull crosses the bay.")

  // New snippet, from the menu: made with the text, the panel still as it was.
  await closePanel(page)
  await editor.focus()
  await sendText.click()
  await menuItem(page, "New snippet").click()
  await expect(page.getByText("Added to snippet “A gull crosses the bay.”", { exact: true })).toBeVisible()
  await expect(page.getByRole("tablist", { name: "Chat panel" })).toHaveCount(0)
  await expect
    .poll(async () => (await admin((api) => api.ListSnippets({ chatId }))).map((s) => s.content))
    .toContain("A gull crosses the bay.")
})

test("on a phone the menu always chooses", async ({ page }, info) => {
  const chatId = await setup(page, 390, ["Alpha"])
  const panel = await openPanel(page, "Snippets")
  await snippetText(panel, "Alpha").click()
  await closePanel(page)
  const { mine, editor, sendText } = await editMessage(page)
  await audit(page, info, mine, "strip-390")
  await sendText.click()
  await expect(menu(page)).toBeVisible()
  await audit(page, info, menu(page), "menu-390")
  await menuItem(page, "Alpha").click()
  await expect(page.getByText("Added to snippet “Alpha”", { exact: true })).toBeVisible()
  await expect(editor).toBeFocused()
  await expect.poll(() => content(chatId, "Alpha")).toBe("Alpha notes.\n\nA gull crosses the bay.")
})
