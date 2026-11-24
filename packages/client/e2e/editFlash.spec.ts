// Opening a message's edit never shows its box blank (owner, 2026-11-23: "the first time I open
// a chat message for editing, it flashes blank for an instant", once per page load). On a cold
// page (a fresh browser context, so the editor's code isn't loaded yet), every animation frame
// from the double-click until the editor shows has the message's text on screen in that box:
// the rendered text until the editor has drawn its text in the same place, then the editor's.
// Also with the CPU slowed four times, as on a phone.
import { expect, type Browser, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

const TEXT = [
  'Mira sets the kettle down. "You came back," she says, and *doesn\'t* look up from the table.',
  "Outside, the wind worries at the shutters. Somewhere below, a door bangs twice and is still."
].join("\n\n")

interface Frame {
  /** The rendered text, drawn and opaque. */
  readonly rendered: boolean
  /** The editor's text, drawn and opaque. */
  readonly editor: boolean
  /** The box holding either: its height. */
  readonly height: number
}

/** Samples, on every animation frame, whether the message's text is on screen, rendered or in its editor. */
const sampleFrames = (page: Page, slot: string) =>
  page.evaluate((slot) => {
    const article = document.querySelector(`article[data-slot="${slot}"]`)!
    const frames: Frame[] = []
    const shown = (element: Element | null | undefined) => {
      if (!element || !(element.textContent ?? "").trim()) return false
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return false
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false
      // checkVisibility doesn't see through a shadow root: the host's ancestors count too.
      for (let node: Node | null = element; node;) {
        if (node instanceof Element) {
          const style = getComputedStyle(node)
          if (style.opacity === "0" || style.visibility === "hidden" || style.display === "none") return false
        }
        node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null)
      }
      return true
    }
    const editorContent = () => {
      for (const element of article.querySelectorAll("*")) {
        const content = element.shadowRoot?.querySelector(".cm-content") ?? null
        if (content) return content
      }
      return article.querySelector(".cm-content")
    }
    const body = () => article.querySelector(".message-content") ?? article
    ;(window as unknown as { __frames: Frame[]; __sampling: boolean }).__frames = frames
    ;(window as unknown as { __sampling: boolean }).__sampling = true
    const tick = () => {
      const rendered = shown(article.querySelector(".markdown"))
      const editor = shown(editorContent())
      frames.push({ rendered, editor, height: body().getBoundingClientRect().height })
      if ((window as unknown as { __sampling: boolean }).__sampling) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, slot)

const run = async (browser: Browser, width: number, throttle: boolean) => {
  // A fresh context: nothing of the editor's code is cached in it yet.
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 } })
  const page = await context.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const { chatId, slot } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: `Flash ${width} ${throttle ? "slow" : "fast"}` })
      const sent = yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: TEXT })
      if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
      return { chatId: chat.id, slot: sent.entry.slotId }
    })
  )
  if (throttle) {
    const cdp = await context.newCDPSession(page)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  }
  await page.goto(`${server().url}/chats/${chatId}`)
  const message = page.locator(`article[data-slot="${slot}"]`)
  const body = message.locator(".markdown")
  await expect(body).toContainText("shutters")
  const pointOf = () =>
    body.evaluate((node) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const at = text.textContent!.indexOf("shutters")
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(text, at + 2)
        range.setEnd(text, at + 3)
        const rect = range.getBoundingClientRect()
        return { x: rect.left + 1, y: rect.top + rect.height / 2 }
      }
      throw new Error("no word")
    })
  // Over the word, once the list has settled where it opened (it scrolls to the end as it loads).
  let point = await pointOf()
  await expect
    .poll(async () => {
      const next = await pointOf()
      const same = next.x === point.x && next.y === point.y
      point = next
      return same
    })
    .toBe(true)
  await page.mouse.move(point.x, point.y)
  await sampleFrames(page, slot)
  await page.mouse.dblclick(point.x, point.y)
  const editor = message.getByRole("textbox", { name: "Message text", exact: true })
  await expect(editor).toBeFocused({ timeout: 15_000 })
  // A few frames more once it's there.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done))))
  )
  const frames = await page.evaluate(() => {
    ;(window as unknown as { __sampling: boolean }).__sampling = false
    return (window as unknown as { __frames: Frame[] }).__frames
  })
  const blank = frames.flatMap((frame, i) => (frame.rendered || frame.editor ? [] : [i]))
  expect(frames.length).toBeGreaterThan(1)
  expect(blank, `blank frames of ${frames.length}: ${JSON.stringify(frames.slice(0, 60))}`).toEqual([])
  expect(frames.at(-1)!.editor).toBe(true)
  // The box keeps its height throughout.
  const heights = frames.map((frame) => frame.height)
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(0.5)
  await context.close()
}

for (const width of [1440, 390])
  for (const throttle of [false, true])
    test(`a cold page's first edit never shows the message blank at ${width}${throttle ? ", CPU 4x slower" : ""}`, async ({
      browser
    }) => {
      test.setTimeout(90_000)
      await run(browser, width, throttle)
    })
