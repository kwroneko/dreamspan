import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { THOUGHT, startContinueProvider } from "./support/continueProvider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

async function select(page: Page, start: string, from: number, end = start, to?: number) {
  await page.evaluate(
    ({ start, from, end, to }) => {
      const first = document.querySelector(start)!
      const last = document.querySelector(end)!
      const firstText = document.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode()!
      const lastText = document.createTreeWalker(last, NodeFilter.SHOW_TEXT).nextNode()!
      const range = document.createRange()
      range.setStart(firstText, from)
      range.setEnd(lastText, to ?? lastText.textContent!.length)
      const selection = document.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    },
    { start, from, end, to }
  )
}

async function clipboard(page: Page) {
  await page.keyboard.press("Control+c")
  return page.evaluate(() => navigator.clipboard.readText())
}

for (const width of [1440, 390]) {
  test(`copies stored slices from rendered messages at ${width}`, async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "Clipboard read permissions are exercised in Chromium")
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      permissions: ["clipboard-read", "clipboard-write"]
    })
    const page = await context.newPage()
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const fixture = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateChat({ title: "Synthetic source-copy selections" })
        yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
        const first = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          content: "Before *hello* after  \nnext"
        })
        if (first._tag !== "Posted") throw new Error("expected first message")
        const second = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: first.entry.slotId,
          branch: false,
          content:
            'Second __world__.\n\n*unfinished\n\n"unfinished quote\n\nBefore ![harbor](https://example.com/h.png) after\n\n```js\nconst x = 1\nnext()\n```'
        })
        if (second._tag !== "Posted") throw new Error("expected second message")
        return { chat, first: first.entry.slotId, second: second.entry.slotId }
      })
    )
    await page.goto(`${server().url}/chats/${fixture.chat.id}`)
    const first = `article[data-slot="${fixture.first}"] [data-message-source]`
    const second = `article[data-slot="${fixture.second}"] [data-message-source]`
    await expect(page.locator(`${first} em`)).toHaveText("hello")
    await expect(page.locator(`${second} u`)).toHaveText("world")

    await select(page, `${first} em`, 0)
    expect(await clipboard(page)).toBe("*hello*")
    const rich = await page.evaluate(async () => {
      const items = await navigator.clipboard.read()
      const item = items.find((item) => item.types.includes("text/html"))!
      const html = await (await item.getType("text/html")).text()
      return new DOMParser().parseFromString(html, "text/html").querySelector("em")?.textContent
    })
    expect(rich).toBe("hello")

    await select(page, `${first} em`, 0, `${first} em`, 2)
    expect(await clipboard(page)).toBe("*he")
    await select(page, `${first} em`, 1, `${first} em`, 3)
    expect(await clipboard(page)).toBe("el")
    await select(page, `${first} em`, 2)
    expect(await clipboard(page)).toBe("llo*")
    await select(page, `${first} em`, 0, `${second} u`)
    expect(await clipboard(page)).toBe("*hello* after  \nnext\n\nSecond __world__")

    await page.locator(`${first} p`).evaluate((paragraph) => {
      const range = document.createRange()
      range.selectNodeContents(paragraph)
      range.setEndAfter(paragraph.querySelector("br")!)
      document.getSelection()!.removeAllRanges()
      document.getSelection()!.addRange(range)
    })
    expect(await clipboard(page)).toBe("Before *hello* after  \n")
    await page.locator(`${first} br`).evaluate((br) => {
      const range = document.createRange()
      range.selectNode(br)
      document.getSelection()!.removeAllRanges()
      document.getSelection()!.addRange(range)
    })
    expect(await clipboard(page)).toBe("  \n")

    await select(page, `${second} em`, 0)
    expect(await clipboard(page)).toBe("*unfinished")
    const quoteLength = (await page.locator(`${second} q`).textContent())!.length
    await select(page, `${second} q`, quoteLength - 1, `${second} q`, quoteLength)
    expect(await clipboard(page)).toBe("")
    await select(page, `${second} .md-blocked`, 16, `${second} .md-blocked`, 22)
    expect(await clipboard(page)).toBe("![harbor](https://example.com/h.png)")
    await select(page, `${second} [data-streamdown="code-block-header"]`, 0)
    expect(await clipboard(page)).toBe("")
    await page.locator(`${second} [data-streamdown="code-block"]`).evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      document.getSelection()!.removeAllRanges()
      document.getSelection()!.addRange(range)
    })
    expect(await clipboard(page)).toBe("```js\nconst x = 1\nnext()\n```")
    const richCode = await page.evaluate(async () => {
      const item = (await navigator.clipboard.read()).find((item) => item.types.includes("text/html"))!
      const html = await (await item.getType("text/html")).text()
      return new DOMParser().parseFromString(html, "text/html").querySelector("pre code")?.textContent
    })
    expect(richCode).toBe("const x = 1\nnext()")

    // A native text editor, even with an old message selection, keeps browser copy.
    await page.evaluate(() => {
      const editor = document.createElement("textarea")
      editor.value = "editor *literal* text"
      document.body.appendChild(editor)
      editor.focus()
      editor.setSelectionRange(7, 16)
    })
    expect(await clipboard(page)).toBe("*literal*")
    const composer = page.getByLabel("Message", { exact: true })
    await composer.fill("composer *literal* text")
    await composer.press("Control+a")
    expect(await clipboard(page)).toBe("composer *literal* text")
    await context.close()
  })
}

test("copies live reply and reasoning text while generation is held", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "Clipboard read permissions are exercised in Chromium")
  const provider = await startContinueProvider()
  provider.holdNextReply()
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] })
  try {
    const page = await context.newPage()
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const fixture = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        yield* api.SetDisplayPrefs({ prefs: { reasoning: "expanded" } })
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Synthetic source-copy stream",
            baseUrl: provider.baseUrl,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        const model = yield* api.AddUserModel({ connectionId: connection.id, key: "native-prefill", overrides: {} })
        yield* api.SetGenerationDefaults({
          defaults: { model: { connection: connection.id, model: model.id }, preset: null }
        })
        const chat = yield* api.CreateChat({ title: "Synthetic streaming copy" })
        yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
        yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "The road flooded." })
        return chat
      })
    )
    await page.goto(`${server().url}/chats/${fixture.id}`)
    await page
      .getByRole("button", { name: /^(Reply$|Generate(?! another))/ })
      .last()
      .click()
    const reply = page.getByRole("article").last()
    await expect(reply.getByRole("button", { name: /Reasoning/ })).toHaveAttribute("aria-expanded", "true")
    await expect(reply.locator(".markdown").last()).toContainText("The ledger says otherwise")
    const slot = await reply.getAttribute("data-slot")
    const reasoning = `article[data-slot="${slot}"] [aria-label="Reasoning"] [data-message-source] p`
    await select(page, reasoning, 0)
    expect(await clipboard(page)).toBe(THOUGHT)
    const body = reply.locator("[data-message-source]").last()
    await body.evaluate((element) => element.setAttribute("data-copy-live-test", ""))
    await select(page, `[data-copy-live-test] p`, 0, `[data-copy-live-test] p`, 3)
    expect(await clipboard(page)).toBe("The")
    await page.getByRole("button", { name: "Stop", exact: true }).click()
  } finally {
    await context.close()
    await provider.stop()
  }
})
