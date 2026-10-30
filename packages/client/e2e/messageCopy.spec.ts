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

async function dragSelection(page: Page) {
  await page.evaluate(() => {
    const target = document.createElement("div")
    target.id = "copy-drop-target"
    target.textContent = "Synthetic external drop receiver"
    target.style.cssText = "position:fixed;right:8px;bottom:8px;width:180px;height:40px;z-index:99999;background:white"
    target.addEventListener("dragover", (event) => event.preventDefault())
    target.addEventListener("drop", (event) => {
      event.preventDefault()
      target.dataset.plain = event.dataTransfer!.getData("text/plain")
      target.dataset.html = event.dataTransfer!.getData("text/html")
    })
    document.body.appendChild(target)
  })
  const origin = await page.evaluate(() => {
    const rect = document.getSelection()!.getRangeAt(0).getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })
  const target = page.locator("#copy-drop-target")
  const box = (await target.boundingBox())!
  await page.mouse.move(origin.x, origin.y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 })
  await page.mouse.up()
  await expect(target).toHaveAttribute("data-plain", "*he")
  await expect(target).toHaveAttribute("data-html", /<em>/)
  await target.evaluate((element) => element.remove())
}

for (const width of [1440, 390]) {
  test(`copies stored slices from rendered messages at ${width}`, async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "Clipboard read permissions are exercised in Chromium")
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      isMobile: width === 390,
      hasTouch: width === 390,
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
            'Second __world__.\n\n*unfinished\n\n"unfinished quote\n\nBefore ![harbor](https://example.com/h.png) after\n\n```js\nconst x = 1\n\nnext()\n```'
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

    // Native menu/phone Copy dispatches the same copy event without a keydown.
    await select(page, `${first} em`, 0, `${first} em`, 2)
    const transfers = await page.locator(`${first} em`).evaluate((element) => {
      return ["copy", "dragstart"].map((type) => {
        const data = new DataTransfer()
        data.setData("text/plain", "he")
        const event =
          type === "copy"
            ? new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: data })
            : new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data })
        element.dispatchEvent(event)
        return { type, text: data.getData("text/plain"), cancelled: event.defaultPrevented }
      })
    })
    expect.soft(transfers).toEqual([
      { type: "copy", text: "*he", cancelled: true },
      { type: "dragstart", text: "*he", cancelled: false }
    ])

    // Invoke the browser Copy command without keyboard input, as native menus do.
    expect(await page.evaluate(() => document.execCommand("copy"))).toBe(true)
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("*he")
    await page.locator(`${first} em`).scrollIntoViewIfNeeded()
    await select(page, `${first} em`, 0, `${first} em`, 2)
    await dragSelection(page)

    await page.locator(first).evaluate((body) => {
      const before = document.createElement("span")
      before.id = "copy-outside-before"
      before.textContent = "Outside before: "
      const after = document.createElement("span")
      after.id = "copy-outside-after"
      after.textContent = " :outside after"
      body.before(before)
      body.after(after)
    })
    await select(page, "#copy-outside-before", 0, `${first} em`, 2)
    const nativePrefix = await page.evaluate(() => document.getSelection()!.toString())
    expect.soft(await clipboard(page)).toBe(nativePrefix.replace("Before he", "Before *he"))
    await select(page, `${first} em`, 2, "#copy-outside-after")
    const nativeSuffix = await page.evaluate(() => document.getSelection()!.toString())
    expect.soft(await clipboard(page)).toBe(nativeSuffix.replace("llo after\nnext", "llo* after  \nnext"))
    await select(page, "#copy-outside-before", 0, "#copy-outside-after")
    const nativeBoth = await page.evaluate(() => document.getSelection()!.toString())
    // A backward selection must retain both its direction and its text.
    await page.evaluate(() => {
      const selection = document.getSelection()!
      selection.setBaseAndExtent(
        selection.focusNode!,
        selection.focusOffset,
        selection.anchorNode!,
        selection.anchorOffset
      )
    })
    const direction = await page.evaluate(() => {
      const selection = document.getSelection()!
      return { anchor: selection.anchorNode!.textContent, offset: selection.anchorOffset }
    })
    expect
      .soft(await clipboard(page))
      .toBe(nativeBoth.replace("Before hello after\nnext", "Before *hello* after  \nnext"))
    expect(await page.evaluate(() => document.getSelection()!.toString())).toBe(nativeBoth)
    expect(
      await page.evaluate(() => {
        const selection = document.getSelection()!
        return { anchor: selection.anchorNode!.textContent, offset: selection.anchorOffset }
      })
    ).toEqual(direction)
    await select(page, "#copy-outside-before", 0, "#copy-outside-before", 7)
    expect(await clipboard(page)).toBe("Outside")
    await page.locator("#copy-outside-before, #copy-outside-after").evaluateAll((elements) => {
      for (const element of elements) element.remove()
    })

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
    expect(await clipboard(page)).toBe("```js\nconst x = 1\n\nnext()\n```")
    const richCode = await page.evaluate(async () => {
      const item = (await navigator.clipboard.read()).find((item) => item.types.includes("text/html"))!
      const html = await (await item.getType("text/html")).text()
      return new DOMParser().parseFromString(html, "text/html").querySelector("pre code")?.textContent
    })
    expect(richCode).toBe("const x = 1\n\nnext()")

    await page.locator(`${second} pre code`).evaluate((code) => {
      const lines = code.querySelectorAll(":scope > span.block")
      const range = document.createRange()
      range.setStartAfter(lines[0]!.lastChild!)
      range.setEndBefore(lines[1]!.firstChild!)
      document.getSelection()!.removeAllRanges()
      document.getSelection()!.addRange(range)
    })
    expect.soft(await clipboard(page)).toBe("\n")
    await page.locator(`${second} pre code`).evaluate((code) => {
      const lines = code.querySelectorAll(":scope > span.block")
      const range = document.createRange()
      range.setStart(lines[1]!, 0)
      range.setEnd(lines[2]!, 0)
      document.getSelection()!.removeAllRanges()
      document.getSelection()!.addRange(range)
    })
    expect.soft(await clipboard(page)).toBe("\n")

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
