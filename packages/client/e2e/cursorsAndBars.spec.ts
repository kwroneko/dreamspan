// Controls show the pointer, and look the same on both sides of a chat; scrollbars are thin
// and quiet with a gap before the cards (styles.css, its base layer). The owner, 2026-11-01:
// "The buttons on messages don't even seem to switch to pointer cursor", "the buttons look
// different on hover on user vs generated turns", "no pointer cursor over the cards".
// Every card and chat here is made up. SCREENSHOT_DIR keeps the screenshots; the browser is
// launched with its scrollbars shown (headless Chromium hides them by default).
import { join } from "node:path"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { showActions } from "./support/message.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { saveButton } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { modelChip } from "./support/strip.ts"

test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } })

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let chatId: ChatId
let cardIds: string[]

const NAMES = [
  "Mira",
  "Bo",
  "Wren",
  "Ash",
  "Juno",
  "Pell",
  "Tamsin",
  "Orrin",
  "Lark",
  "Sable",
  "Ivo",
  "Nell",
  "Corvin",
  "Ysolde"
]

test.beforeAll(async () => {
  provider = await startProvider()
  ;({ chatId, cardIds } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local model server",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: 300,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-cursor-test-0042"
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      // Enough cards and chats that the sidebar's grid and list scroll.
      let first: ChatId | null = null
      const cards: string[] = []
      for (const name of NAMES) {
        const card = yield* api.CreateCard({ label: name, name })
        cards.push(card.id)
        const started = yield* api.StartChat({
          cards: [card.entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: `${name} waits by the gate.`, speakerEntityId: null }
        })
        if (first === null) {
          yield* api.Generate({ chatId: started.chat.id, parentSlotId: started.entry.slotId, branch: false })
          first = started.chat.id
        }
      }
      return { chatId: first!, cardIds: cards }
    })
  ))
})
test.afterAll(async () => {
  await provider.stop()
})

const shoot = async (page: Page, name: string) => {
  const dir = process.env.SCREENSHOT_DIR
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`) })
}
const cursor = (target: Locator) => target.evaluate((element) => getComputedStyle(element).cursor)
/** What a control looks like with the pointer over it, after its color transition. */
const hovered = async (target: Locator) => {
  await target.hover()
  await target.page().waitForTimeout(300)
  return target.evaluate((element) => {
    const style = getComputedStyle(element)
    const { width, height } = element.getBoundingClientRect()
    return {
      background: style.backgroundColor,
      color: style.color,
      cursor: style.cursor,
      radius: style.borderRadius,
      padding: style.padding,
      width,
      height
    }
  })
}

const sidebar = (page: Page) => page.getByRole("complementary").first()

for (const theme of ["light", "dark"] as const)
  test(`controls show the pointer and message actions look alike on both sides (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chatId}`)
    const mine = page.getByRole("article", { name: "Your message", exact: true }).first()
    const reply = page.getByRole("article", { name: "Reply", exact: true }).last()
    await expect(reply.locator(".markdown")).not.toBeEmpty()

    // A message's actions: the same look on hover, the pointer, on both sides.
    await showActions(mine)
    const mineMore = await hovered(mine.getByRole("button", { name: "More actions" }))
    await shoot(page, `message-hover-user-${theme}`)
    await showActions(reply)
    const replyMore = await hovered(reply.getByRole("button", { name: "More actions" }))
    await shoot(page, `message-hover-reply-${theme}`)
    expect(replyMore).toEqual(mineMore)
    expect(mineMore.cursor).toBe("pointer")
    // The hover wash shows on the user's raised surface too: not that surface's own color.
    const surface = await mine.evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(mineMore.background).not.toBe(surface)
    expect(mineMore.background).not.toBe("rgba(0, 0, 0, 0)")
    // The version arrow is the same button.
    await showActions(reply)
    const arrow = await hovered(reply.getByRole("button", { name: "Generate another swipe" }))
    expect(arrow.background).toBe(replyMore.background)
    expect(arrow.cursor).toBe("pointer")

    // A menu item.
    await reply.getByRole("button", { name: "More actions" }).click()
    const item = page.getByRole("menuitem").first()
    await expect(item).toBeVisible()
    expect(await cursor(item)).toBe("pointer")
    await page.keyboard.press("Escape")

    // A tab, a chip in the next-reply strip, the message box.
    await page.getByRole("button", { name: "Chat panel", exact: true }).click()
    const tab = page.getByRole("tab", { name: "This chat", exact: true })
    await expect(tab).toBeVisible()
    expect(await cursor(tab)).toBe("pointer")
    await expect(page.getByText("Loading the chat settings…")).toHaveCount(0)
    await shoot(page, `side-panel-${theme}`)
    expect(await cursor(modelChip(page))).toBe("pointer")
    const box = page.getByRole("textbox", { name: "Message", exact: true })
    expect(["text", "auto"]).toContain(await cursor(box))

    // Chat rows and character tiles, over their whole area (what's inside inherits).
    const row = sidebar(page)
      .getByRole("link", { name: /^Open chat / })
      .first()
    expect(await cursor(row)).toBe("pointer")
    expect(await cursor(row.locator("span").first())).toBe("pointer")
    await shoot(page, `chat-list-${theme}`)
    await sidebar(page).getByRole("button", { name: "Characters", exact: true }).click()
    const tile = sidebar(page)
      .getByRole("link", { name: /^Open / })
      .first()
    await expect(tile).toBeVisible()
    expect(await cursor(tile)).toBe("pointer")
    expect(await cursor(tile.locator("span").last())).toBe("pointer")
    await shoot(page, `sidebar-characters-${theme}`)
    await sidebar(page).getByRole("button", { name: "Chats", exact: true }).click()

    await page.goto(server().url)
    const home = page.getByRole("main").getByLabel("Characters", { exact: true })
    const homeTile = home.getByRole("link", { name: /^Open / }).first()
    await expect(homeTile).toBeVisible()
    expect(await cursor(homeTile)).toBe("pointer")
    await shoot(page, `home-${theme}`)
  })

test("scrollbars are thin and quiet, stronger on hover, with a gap before the sidebar's cards", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  await sidebar(page).getByRole("button", { name: "Characters", exact: true }).click()
  const tile = sidebar(page)
    .getByRole("link", { name: /^Open / })
    .first()
  await expect(tile).toBeVisible()
  const list = tile.locator("xpath=ancestor::div[contains(@class,'overflow-y-auto')][1]")
  const bars = await list.evaluate((element) => {
    const style = getComputedStyle(element)
    // Chromium and WebKit use pseudo-elements to remove the step arrows (6c0ceb608).
    const webkit = CSS.supports("selector(::-webkit-scrollbar)")
    const grid = element.firstElementChild!.getBoundingClientRect()
    const box = element.getBoundingClientRect()
    return {
      width: webkit ? getComputedStyle(element, "::-webkit-scrollbar").width : style.scrollbarWidth,
      stepButtons: webkit ? getComputedStyle(element, "::-webkit-scrollbar-button").display : null,
      webkit,
      gutter: style.scrollbarGutter,
      scrolls: element.scrollHeight > element.clientHeight,
      // From the cards' right edge to the scrollbar's left edge.
      gap: box.left + element.clientLeft + element.clientWidth - grid.right
    }
  })
  expect(bars.width).toBe(bars.webkit ? "8px" : "thin")
  if (bars.webkit) expect(bars.stepButtons).toBe("none")
  expect(bars.gutter).toContain("stable")
  expect(bars.scrolls).toBe(true)
  expect(bars.gap).toBeGreaterThanOrEqual(4)
  const thumbColor = (element: Element) =>
    CSS.supports("selector(::-webkit-scrollbar)")
      ? getComputedStyle(element, "::-webkit-scrollbar-thumb").backgroundColor
      : getComputedStyle(element).scrollbarColor
  await page.mouse.move(0, 0)
  const quiet = await list.evaluate(thumbColor)
  await list.hover()
  await expect.poll(() => list.evaluate(thumbColor)).not.toBe(quiet)
})

for (const theme of ["light", "dark"] as const)
  test(`scrollbars on a settings page, in a code editor and the library; a disabled button (${theme})`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 1440, height: 700 })
    await page.emulateMedia({ colorScheme: theme })
    await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/settings/chats`)
    await expect(page.getByRole("main")).toBeVisible()
    await page.waitForTimeout(500)
    await shoot(page, `settings-${theme}`)
    await page.goto(`${server().url}/library/${cardIds[theme === "light" ? 0 : 1]}`)
    const description = page.getByRole("textbox", { name: "Description", exact: true })
    // A disabled button: Save, with nothing changed yet.
    const save = saveButton(page)
    await expect(save).toBeDisabled()
    expect(await cursor(save)).toBe("default")
    await description.click()
    await page.keyboard.insertText(
      Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long synthetic description.`).join("\n")
    )
    await description.hover()
    await shoot(page, `code-editor-${theme}`)
    await page.goto(`${server().url}/library`)
    await page.waitForTimeout(500)
    await shoot(page, `library-${theme}`)
  })
