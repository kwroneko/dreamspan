// A reply's thinking, edited on its own (thinkedit2; SillyTavern's reasoning block edit, Add and
// remove): the message's edit never shows it; the panel's Edit, explained on hover, opens it in
// the panel's place, its Save, Cancel and Delete and token count in the strip inside its box; a
// double-click on the thinking opens it with the caret there, never the message's edit;
// cancelled, nothing changes; changed, saved as a new swipe with the text as it was; deleted and added again (from the message's actions) on the user's own version, the
// text kept across a reload before Save; and the ST export carrying it as extra.reasoning. At
// desktop and phone widths, light and dark, with a layout audit of the open editor. Synthetic
// chat only.
import { mkdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { messageMenu, showActions } from "./support/message.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox, replaceEditorText } from "./support/textbox.ts"

const server = serverPerFile({
  ...withAdmin,
  FAKE_GENERATOR_TPS: "200",
  FAKE_GENERATOR_TOKENS: "20",
  FAKE_GENERATOR_REASONING: "12"
})
const shots = process.env.SCREENSHOT_DIR

// One login per server, not one per poll: logins at once beyond the password checks' limit
// are refused (Accounts.ts), and four tests share the server.
let session: { url: string; cookie: Promise<string> } | undefined
const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => {
  if (session?.url !== server().url)
    session = { url: server().url, cookie: loginCookie(server(), ADMIN.handle, ADMIN.password) }
  return session.cookie.then((cookie) => withCookie(server(), cookie, use))
}

const lastEntry = (chatId: string) =>
  admin((api) =>
    api
      .ReadPath({ chatId: chatId as never, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      .pipe(Effect.map((path) => path.entries.at(-1)!))
  )

test("the phone thinking editor locks its disclosure, message actions and pending save", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chat = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Thinking save in progress" })
      const sent = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "A synthetic message.",
        reply: false
      })
      if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
      yield* api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false })
      return chat
    })
  )
  const held: { release?: () => void } = {}
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      if (typeof data === "string" && JSON.parse(data).tag === "EditVersion") held.release = () => upstream.send(data)
      else upstream.send(data)
    })
  })
  await page.goto(`${server().url}/chats/${chat.id}`)
  const reply = page.getByRole("article").last()
  const panel = reply.locator('[data-reasoning-panel="reasoning"]')
  const disclosure = panel.getByRole("button", { name: /^Reasoning \d/ })
  await disclosure.click()
  await showActions(reply)
  await panel.getByRole("button", { name: "Edit thinking" }).click()
  const thinking = panel.getByRole("textbox", { name: "Thinking", exact: true })
  const controls = panel.locator("[data-thinking-edit]")
  await expect(disclosure).toBeDisabled()
  await expect(disclosure).toHaveAttribute("aria-expanded", "true")
  const region = panel.getByRole("region", { name: "Reasoning" })
  await expect(region).toHaveAttribute("id", (await disclosure.getAttribute("aria-controls"))!)
  await expect(region.getByRole("textbox", { name: "Thinking", exact: true })).toBeVisible()
  await expect(reply.getByRole("button", { name: "More actions", exact: true })).toBeDisabled()

  const submitted = "The submitted thinking."
  await replaceEditorText(thinking, submitted)
  await controls.getByRole("button", { name: "Save thinking" }).click()
  try {
    await expect.poll(() => held.release !== undefined).toBe(true)
    await expect(thinking).not.toBeEditable()
    await expect(controls.getByRole("button", { name: "Delete thinking" })).toBeDisabled()
    await expect(controls.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled()
    await thinking.click()
    await page.keyboard.type("Ignored")
    await thinking.press("Escape")
    await expectTextBox(thinking, submitted)
  } finally {
    held.release?.()
  }
  await expect(thinking).toHaveCount(0)
  expect((await lastEntry(chat.id)).version.reasoning).toBe(submitted)
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a reply's thinking is edited, deleted and added on its own, and exported, at ${width} ${theme}`, async ({
      page
    }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const shot = async (name: string) => {
        if (shots) {
          mkdirSync(shots, { recursive: true })
          await page.waitForTimeout(150)
          await page.screenshot({ path: resolve(shots, `${name}-${width}-${theme}.png`), animations: "disabled" })
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      }
      const title = `Edit thinking ${width} ${theme}`
      const chat = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "The road flooded."
          })
          if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
          return chat
        })
      )
      await page.goto(`${server().url}/chats/${chat.id}`)
      await page
        .getByRole("button", { name: /^(Reply$|Generate(?! another))/ })
        .last()
        .click()
      await expect.poll(async () => (await lastEntry(chat.id)).version.status, { timeout: 30_000 }).toBe("complete")
      const generated = (await lastEntry(chat.id)).version
      expect(generated.reasoning).toMatch(/\S/)
      const reply = page.getByRole("article").last()
      const panel = reply.locator('[data-reasoning-panel="reasoning"]')
      const thinking = reply.getByRole("textbox", { name: "Thinking", exact: true })
      // Its controls, in the strip inside its box (as a note's or a card field's).
      const thinkingControls = reply.locator("[data-thinking-edit] [data-field-chrome]")
      const editThinking = panel.getByRole("button", { name: "Edit thinking", exact: true })
      const saveThinking = async () => {
        await thinkingControls.getByRole("button", { name: "Save thinking", exact: true }).click()
        await expect(thinking).toHaveCount(0)
      }

      // Editing the message never involves its thinking: no thinking field, no thinking tools,
      // and the panel stays as it was.
      await showActions(reply)
      await reply.getByRole("button", { name: "Edit", exact: true }).click()
      await expect(reply.getByRole("textbox", { name: "Message text", exact: true })).toBeVisible()
      await expect(thinking).toHaveCount(0)
      const messageEdit = reply.getByRole("group", { name: "Edit", exact: true })
      await expect(messageEdit.getByRole("button", { name: /thinking/i })).toHaveCount(0)
      await expect(panel).toBeVisible()
      await messageEdit.getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(reply.getByRole("textbox", { name: "Message text", exact: true })).toHaveCount(0)

      // The panel's own Edit, explained on hover, opens the thinking in the panel's place.
      await editThinking.hover()
      await expect(
        page.getByText(/Edit this thinking in its place, apart from the message's text/).last()
      ).toBeVisible()
      await editThinking.click()
      await expect(thinking).toBeFocused()
      await expectTextBox(thinking, generated.reasoning!)
      await expect(reply.getByRole("textbox", { name: "Message text", exact: true })).toHaveCount(0)
      await expect(editThinking).toHaveCount(0)
      // Save, Cancel and Delete over the box's lower right corner, its token count at the strip's
      // start, counted with the model's tokenizer.
      await expect(thinkingControls.getByRole("button", { name: "Save thinking", exact: true })).toBeVisible()
      await expect(thinkingControls.getByRole("button", { name: "Cancel", exact: true })).toBeVisible()
      await expect(thinkingControls.getByRole("button", { name: "Delete thinking", exact: true })).toBeVisible()
      await expect(thinkingControls.locator("[data-field-tokens]")).toHaveText(/^~?\d[\d,]* tokens$/)
      const frame = await reply.locator("[data-thinking-edit] [data-field-frame]").boundingBox()
      const save = await thinkingControls.getByRole("button", { name: "Save thinking", exact: true }).boundingBox()
      // In the lower right corner, with only the box's height grip after it.
      expect(frame!.x + frame!.width - (save!.x + save!.width)).toBeLessThan(48)
      expect(frame!.y + frame!.height - (save!.y + save!.height)).toBeLessThan(10)
      await shot("edit-thinking")
      await expectLayout(page, info, `edit-thinking-${width}-${theme}`, { scope: "article:last-of-type" })

      // Cancelled: nothing saved, the panel as it was.
      await replaceEditorText(thinking, "Not this.")
      await thinkingControls.getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(thinking).toHaveCount(0)
      expect((await lastEntry(chat.id)).version.reasoning).toBe(generated.reasoning)
      expect((await lastEntry(chat.id)).versionCount).toBe(1)

      // Changed: a new version with the thinking typed and the text as it was, the reply as it
      // came kept among its versions.
      await editThinking.click()
      await replaceEditorText(thinking, "My own plan for the road.")
      await saveThinking()
      await expect.poll(async () => (await lastEntry(chat.id)).version.reasoning).toBe("My own plan for the road.")
      expect((await lastEntry(chat.id)).versionCount).toBe(2)
      expect((await lastEntry(chat.id)).version.content).toBe(generated.content)
      await panel.locator("button[aria-expanded]").click()
      await expect(reply.getByRole("region", { name: "Reasoning" })).toHaveText(/My own plan for the road\./)

      // A double-click on the thinking opens its own editor, never the message's, with the caret
      // in the word double-clicked, as a double-click on the message's text does.
      const word = await reply.getByRole("region", { name: "Reasoning" }).evaluate((node) => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
          const at = text.textContent!.indexOf("plan")
          if (at < 0) continue
          const range = document.createRange()
          range.setStart(text, at + 1)
          range.setEnd(text, at + 2)
          const rect = range.getBoundingClientRect()
          return { x: rect.left + 1, y: rect.top + rect.height / 2 }
        }
        throw new Error("no word")
      })
      await page.mouse.move(word.x, word.y)
      await page.mouse.dblclick(word.x, word.y)
      await expect(thinking).toBeFocused()
      await expect(reply.getByRole("textbox", { name: "Message text", exact: true })).toHaveCount(0)
      const head = await thinking.evaluate(
        (element) =>
          (
            element as HTMLElement & {
              cmTile?: { root: { view: { state: { selection: { main: { head: number } } } } } }
            }
          ).cmTile!.root.view.state.selection.main.head
      )
      const planAt = "My own plan for the road.".indexOf("plan")
      expect(head).toBeGreaterThanOrEqual(planAt)
      expect(head).toBeLessThanOrEqual(planAt + "plan".length)
      // Escape closes it, as Cancel does; the message's editor never opened.
      await page.keyboard.press("Escape")
      await expect(thinking).toHaveCount(0)
      await expect(reply.getByRole("textbox", { name: "Message text", exact: true })).toHaveCount(0)

      // Deleted from the editor's strip; saved, the reply has none.
      await editThinking.click()
      await reply.getByRole("button", { name: "Delete thinking", exact: true }).click()
      await expectTextBox(thinking, "")
      await shot("edit-thinking-removed")
      await expectLayout(page, info, `edit-thinking-removed-${width}-${theme}`, { scope: "article:last-of-type" })
      await saveThinking()
      await expect.poll(async () => (await lastEntry(chat.id)).version.reasoning).toBeUndefined()
      await expect(panel).toHaveCount(0)
      // The user's own version changed in place: no new version.
      expect((await lastEntry(chat.id)).versionCount).toBe(2)

      // Added again from the message's actions, where the panel would be; what's typed outlives
      // a reload before Save.
      await messageMenu(reply, "Add thinking")
      await expect(thinking).toBeFocused()
      await page.keyboard.insertText("Added after the flood.")
      await expect
        .poll(async () =>
          (await admin((api) => api.MessageDrafts({ chatId: chat.id }))).some(
            (draft) => draft.key.field === "reasoning" && draft.content === "Added after the flood."
          )
        )
        .toBe(true)
      await page.reload()
      await expectTextBox(thinking, "Added after the flood.")
      await expect(reply.getByRole("textbox", { name: "Message text", exact: true })).toHaveCount(0)
      await saveThinking()
      await expect.poll(async () => (await lastEntry(chat.id)).version.reasoning).toBe("Added after the flood.")

      // The ST export carries it as the message's extra.reasoning.
      await page.getByRole("button", { name: "Chat actions", exact: true }).click()
      await page.getByRole("menuitem", { name: "Export…", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Export this chat", exact: true })
      const download = page.waitForEvent("download")
      await dialog.getByRole("button", { name: "Export", exact: true }).click()
      const lines = readFileSync(await (await download).path(), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { extra?: { reasoning?: string } })
      expect(lines.at(-1)!.extra?.reasoning).toBe("Added after the flood.")
    })
