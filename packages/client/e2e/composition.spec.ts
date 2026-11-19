// The composition scratchpad (DESIGN §3.1, owner: "Select text in any version, assemble it in the
// scratchpad, commit it as a new version"): Write your own version keeps the version shown above
// the editor, in a box whose bar steps through the versions and adds the version's text or the
// passage selected in it to your version; a snippet's own editor adds its text there too; Add as
// a new version makes it a version of that message, which steps back like any other; the draft
// outlives a reload. Also two views of one chat (the workbench's frames) sharing it, and an agent
// reply composed from. Synthetic text only; a scripted provider on loopback, never a real one.
// Layout audit on the composition at 1440, 1024 and 390, light and dark.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import { AGENT_REPLY, PLAIN_REPLY, startAgentProvider } from "./support/agentProvider.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { messageMenu } from "./support/message.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox, textBoxValue } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)
const shots = process.env.SCREENSHOT_DIR
let provider: Awaited<ReturnType<typeof startAgentProvider>>
test.beforeAll(async () => {
  provider = await startAgentProvider()
})
test.afterAll(async () => {
  await provider.stop()
})
// One login per file: the server limits how often an account logs in.
let cookie: string | undefined
const admin = async <A>(use: (client: Client) => Effect.Effect<A, unknown>) => {
  cookie ??= await loginCookie(server(), ADMIN.handle, ADMIN.password)
  return withCookie(server(), cookie, use)
}

const SWIPES = [
  "*The ferry horn sounds twice.* The deck is wet with rain. Ilse watches the quay slide away.",
  'Ilse holds out a paper bag. "Chestnut? They\'re burnt on one side." A gull follows the stern for a while.',
  "*She tips her head toward the open water.* The far shore is only a rumour of lights."
]

/** A chat whose reply has the provider's reply and three more versions: 4 in all, the last shown. */
const chatWithSwipes = (title: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "agent-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      const ilse = yield* api.CreateCard({ label: "Ilse", name: "Ilse" })
      const chat = yield* api.CreateChat({ title })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: ilse.entityId } })
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Is the ferry late?" })
      return chat.id as ChatId
    })
  )

const path = (chatId: ChatId) =>
  admin((api) => api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 }))

/** Three more versions of the last message, as the user would have written them. */
const addSwipes = async (chatId: ChatId) => {
  for (const content of SWIPES) {
    const window = await path(chatId)
    const entry = window.entries.at(-1)!
    await admin((api) =>
      api.WriteVersion({
        slotId: entry.slotId as SlotId,
        forkId: window.forkId as ForkId,
        content,
        expectedRowVersion: entry.rowVersion
      })
    )
  }
}

const reply = (scope: Page | Locator) => scope.getByRole("article", { name: "Reply", exact: true }).last()
const shownBox = (message: Locator) => message.getByRole("region", { name: "Version shown" })
const yourVersion = (message: Locator) => message.getByRole("textbox", { name: "Your version" })

/** Selects `text` in the rendered version shown, as a drag would: focus leaves the editor. */
const select = (box: Locator, text: string) =>
  box.evaluate((element, wanted) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const nodes: Array<{ node: Node; at: number }> = []
    let all = ""
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node, at: all.length })
      all += node.textContent ?? ""
    }
    const start = all.indexOf(wanted)
    if (start < 0) throw new Error(`No "${wanted}" in the version shown`)
    const end = start + wanted.length
    const point = (offset: number, last: boolean) => {
      const hit = nodes.findLast((item) => (last ? item.at < offset : item.at <= offset))!
      return [hit.node, offset - hit.at] as const
    }
    const range = document.createRange()
    range.setStart(...point(start, false))
    range.setEnd(...point(end, true))
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }, text)

const generateReply = async (page: Page, chatId: ChatId, expected = PLAIN_REPLY) => {
  const before = (await path(chatId)).entries.at(-1)?.version.id
  await page
    .getByRole("button", { name: /^(Reply$|Generate(?! another))/ })
    .last()
    .click()
  // An absent badge can precede the reply's start. Wait for the fixture's completed
  // provider version before adding swipes, so they all target the reply's slot.
  await expect
    .poll(
      async () => {
        const version = (await path(chatId)).entries.at(-1)?.version
        return version?.id !== before && version?.status === "complete" ? version.content : null
      },
      { timeout: 20_000 }
    )
    .toBe(expected)
  await expect(reply(page)).toContainText(expected)
}

const shot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.mouse.move(0, 0)
  await page.screenshot({ path: resolve(shots, `${name}.png`), animations: "disabled" })
}

for (const [width, theme] of [
  [1440, "light"],
  [390, "dark"]
] as const)
  test(`picks passages from several versions, a snippet's text, and adds it as a new version at ${width} ${theme}`, async ({
    page
  }, info) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const chatId = await chatWithSwipes(`Ferry ${width}`)
    await page.goto(`${server().url}/chats/${chatId}`)
    await generateReply(page, chatId)
    await addSwipes(chatId)
    await admin((api) =>
      api.CreateSnippet({ chatId, title: "Best line", content: "*The lamp swings, and her shadow with it.*" })
    )
    await page.reload()
    const message = reply(page)
    await expect(message.getByRole("group", { name: "Versions" })).toContainText("4/4")

    // Write your own version: the version shown stays above the editor, its arrows in the bar.
    await messageMenu(message, "Write your own version")
    const box = shownBox(message)
    await expect(box).toContainText("far shore is only a rumour")
    const versions = box.getByRole("group", { name: "Versions" })
    await expect(versions).toContainText("4/4")
    await expect(yourVersion(message)).toBeFocused()

    // A passage from version 2: its selection button comes with the selection.
    await versions.getByRole("button", { name: "Previous version" }).click()
    await versions.getByRole("button", { name: "Previous version" }).click()
    await expect(versions).toContainText("2/4")
    const barTop = (await versions.boundingBox())!.y
    const addSelection = box.getByRole("button", { name: "Add selection to your version" })
    await expect(addSelection).toHaveCount(0)
    await select(box, "The deck is wet with rain.")
    await expect(addSelection).toBeVisible()
    await addSelection.hover()
    await expect(
      page.getByText("Adds the selected text to the end of your version", { exact: false }).last()
    ).toBeVisible()
    await addSelection.click()
    await expectTextBox(yourVersion(message), "The deck is wet with rain.")

    // All of version 3, after a blank line; the bar stays where it was as versions change length.
    await versions.getByRole("button", { name: "Next version" }).click()
    await expect(versions).toContainText("3/4")
    expect((await versions.boundingBox())!.y).toBeCloseTo(barTop, 0)
    await box.getByRole("button", { name: "Add to your version", exact: true }).click()
    await expectTextBox(yourVersion(message), `The deck is wet with rain.\n\n${SWIPES[1]}`)
    if (process.env.LAYOUT_AUDIT || width === 390)
      await expectLayout(page, info, `composition-${width}-${theme}`, { scope: "[data-composition]" })
    await shot(page, `composition-${width}-${theme}`)

    // Arranged by hand; the draft outlives a reload.
    await yourVersion(message).press("ControlOrMeta+End")
    await page.keyboard.insertText(" She smiles.")
    await expect
      .poll(async () => (await admin((api) => api.MessageDrafts({ chatId }))).map((d) => d.content))
      .toContain(`The deck is wet with rain.\n\n${SWIPES[1]} She smiles.`)
    await page.reload()
    await expectTextBox(yourVersion(reply(page)), `The deck is wet with rain.\n\n${SWIPES[1]} She smiles.`)

    // A snippet's own editor adds its text to the composition; a notice says where it went.
    const snippets = await openPanel(page, "Snippets")
    const snippetText = snippets.getByRole("textbox", { name: "Text of Best line" })
    await snippetText.click()
    const add = snippets.getByRole("button", { name: "Add to your version", exact: true })
    await add.hover()
    await expect(page.getByText("your version of message #2.", { exact: false }).last()).toBeVisible()
    await add.click()
    await expect(page.getByText("Added to your version of message #2")).toBeVisible()
    if (width === 390) await closePanel(page)
    const composed = `The deck is wet with rain.\n\n${SWIPES[1]} She smiles.\n\n*The lamp swings, and her shadow with it.*`
    await expectTextBox(yourVersion(reply(page)), composed)

    // Add as a new version: the fifth, shown; the version before it is one step back.
    await reply(page).getByRole("button", { name: "Add as a new version" }).click()
    const after = reply(page)
    await expect(yourVersion(after)).toHaveCount(0)
    await expect(after.getByRole("group", { name: "Versions" })).toContainText("5/5")
    await expect(after.getByText("Saved as version 5")).toBeVisible()
    await expect(after.locator(".markdown")).toContainText("her shadow with it")
    const stored = (await path(chatId)).entries.at(-1)!.version
    expect(stored.content).toBe(composed)
    expect(stored.origin).toBe("user_written")
    await after.getByRole("group", { name: "Versions" }).getByRole("button", { name: "Previous version" }).click()
    await expect(after.getByRole("group", { name: "Versions" })).toContainText("4/5")
    await expect(after.locator(".markdown")).toContainText("far shore is only a rumour")
    expect(await admin((api) => api.MessageDrafts({ chatId }))).toEqual([])
  })

test("two views of one chat share the composition", async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chatId = await chatWithSwipes("Ferry beside")
  await page.goto(`${server().url}/chats/${chatId}`)
  await generateReply(page, chatId)
  await addSwipes(chatId)
  await page.reload()
  // The same chat beside itself.
  await page
    .getByRole("complementary", { name: "Sidebar" })
    .getByRole("link", { name: /^Open chat Ferry beside/ })
    .click({ modifiers: ["Alt"] })
  const frames = page.locator("[data-frame]")
  await expect(frames).toHaveCount(2)
  const [left, right] = [reply(frames.nth(0)), reply(frames.nth(1))]
  await expect(right.getByRole("group", { name: "Versions" })).toContainText("4/4")

  await messageMenu(left, "Write your own version")
  await expect(yourVersion(left)).toBeFocused()
  await shownBox(left).getByRole("button", { name: "Add to your version", exact: true }).click()
  // The other view shows it, and adds to it from there.
  await expectTextBox(yourVersion(right), SWIPES[2]!)
  const rightBox = shownBox(right)
  await rightBox.getByRole("group", { name: "Versions" }).getByRole("button", { name: "Previous version" }).click()
  await select(rightBox, "A gull follows the stern for a while.")
  await rightBox.getByRole("button", { name: "Add selection to your version" }).click()
  const both = `${SWIPES[2]}\n\nA gull follows the stern for a while.`
  await expectTextBox(yourVersion(right), both)
  await expectTextBox(yourVersion(left), both)
  await shot(page, "composition-two-views-1440")

  // Added as a version in one view: the other closes its composition and shows the version.
  await right.getByRole("button", { name: "Add as a new version" }).click()
  await expect(yourVersion(left)).toHaveCount(0)
  await expect(yourVersion(right)).toHaveCount(0)
  await expect.poll(async () => (await path(chatId)).entries.at(-1)!.version.content).toBe(both)
  await expect(right.getByRole("group", { name: "Versions" })).toContainText("5/5")
})

test("a selection inside italics keeps them", async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chatId = await chatWithSwipes("Ferry italics")
  await page.goto(`${server().url}/chats/${chatId}`)
  await generateReply(page, chatId)
  await addSwipes(chatId)
  await page.reload()
  const message = reply(page)
  await messageMenu(message, "Write your own version")
  await expect(yourVersion(message)).toBeFocused()
  const box = shownBox(message)
  const addSelection = box.getByRole("button", { name: "Add selection to your version" })
  // Inside the italics, then from inside them to past their end.
  await select(box, "her head toward")
  await addSelection.click()
  await expectTextBox(yourVersion(message), "*her head toward*")
  await select(box, "the open water. The far shore")
  await addSelection.click()
  await expectTextBox(yourVersion(message), "*her head toward*\n\n*the open water.* The far shore")
})

test("an agent reply is composed from like any other", async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chatId = await chatWithSwipes("Ferry agent")
  await admin((api) => api.ChangeCast({ chatId, slotId: null, change: { _tag: "AgentEnabled", on: true } }))
  await page.goto(`${server().url}/chats/${chatId}`)
  await generateReply(page, chatId, AGENT_REPLY)
  const message = reply(page)
  await expect(message).toContainText(AGENT_REPLY)
  await expect(message.locator("[data-steps-badge]")).toBeVisible()
  await messageMenu(message, "Write your own version")
  await expect(yourVersion(message)).toBeFocused()
  const box = shownBox(message)
  await select(box, "points across the flooded bridge")
  await box.getByRole("button", { name: "Add selection to your version" }).click()
  await expectTextBox(yourVersion(message), "points across the flooded bridge")
  await yourVersion(message).press("ControlOrMeta+Home")
  await page.keyboard.insertText("Ilse ")
  await message.getByRole("button", { name: "Add as a new version" }).click()
  await expect(reply(page).getByRole("group", { name: "Versions" })).toContainText("2/2")
  await expect
    .poll(async () => (await path(chatId)).entries.at(-1)!.version.content)
    .toBe("Ilse points across the flooded bridge")
  expect(PLAIN_REPLY).not.toBe(AGENT_REPLY)
})

for (const width of [1440, 1024, 390])
  for (const theme of ["light", "dark"] as const)
    test(`composition layout at ${width} ${theme}`, async ({ page }, info) => {
      test.skip(!process.env.LAYOUT_AUDIT, "layout audit only")
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const chatId = await chatWithSwipes(`Ferry layout ${width} ${theme}`)
      await page.goto(`${server().url}/chats/${chatId}`)
      await generateReply(page, chatId)
      await addSwipes(chatId)
      await page.reload()
      const message = reply(page)
      await messageMenu(message, "Write your own version")
      await expect(yourVersion(message)).toBeFocused()
      const box = shownBox(message)
      await select(box, "The far shore is only a rumour of lights.")
      await expect(box.getByRole("button", { name: "Add selection to your version" })).toBeVisible()
      await box.getByRole("button", { name: "Add to your version", exact: true }).click()
      expect(await textBoxValue(yourVersion(message))).toContain("rumour of lights")
      await expectLayout(page, info, `composition-${width}-${theme}`, { scope: "[data-composition]" })
      await shot(page, `composition-layout-${width}-${theme}`)
    })
