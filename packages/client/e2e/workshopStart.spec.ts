// The workshop beside a story before it exists (owner, 2026-11-17: "It should be a chat UI already
// open with the composer ... The chat is created when the first message is sent."): the Workshop
// tab opens on a pending chat shown as a saved workshop is, "new" in its header (what it is on
// the badge's hover), and its composer, focused; the first send starts that chat in place and
// sends the message; "new" is gone after it, and a reload keeps the workshop. At 1440 and 390,
// light and dark, with the layout audit. Synthetic data and a scripted loopback provider only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import {
  expectNewSideHint,
  makeStory,
  pendingSideChat,
  SIDE_ANSWER,
  sideChatId,
  sidePanel,
  useSideChatProvider
} from "./support/workshopSideChat.ts"
import { expectTextBox } from "./support/textbox.ts"

const shots = process.env.SCREENSHOT_DIR
const QUESTION = "What has happened in the harbor so far?"

test.describe("a workshop made by its first message", () => {
  const server = serverPerFile(withAdmin)
  useSideChatProvider(server)

  test("retrying the first message after a reload opens the same workshop", async ({ page }) => {
    const story = await makeStory(server, "Harbor retry")
    const bound = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.GetChat({ chatId: story.id }))
    const attached = () =>
      asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.ListAttachedWorkshops({ chatId: story.id, forkId: bound.currentForkId! })
      )
    let failed = false
    await page.routeWebSocket("**/rpc", (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        const request =
          typeof data === "string"
            ? (JSON.parse(data) as {
                tag?: string
                id?: string
                payload?: { chatId?: string }
              })
            : null
        if (
          !failed &&
          request?.tag === "SendMessage" &&
          request.payload?.chatId &&
          request.payload.chatId !== story.id
        ) {
          failed = true
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: request.id,
              exit: {
                _tag: "Failure",
                cause: [{ _tag: "Fail", error: { _tag: "ServerError", message: "Send interrupted" } }]
              }
            })
          )
        } else upstream.send(data)
      })
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${story.id}?panel=workshop&workshop=new`)
    const panel = sidePanel(page)
    const pending = pendingSideChat(page)
    await expect(pending).toBeVisible({ timeout: 30_000 })
    const workshopId = await sideChatId(pending)
    const box = panel.getByLabel("Message", { exact: true })
    const send = panel.getByRole("button", { name: /^Send( as .+)?$/ })
    await box.fill(QUESTION)
    await send.click()
    await expect(panel.getByRole("alert")).toBeVisible()
    expect(failed).toBe(true)
    // Not started: nothing beside the story yet, and the tab still shows the same new one.
    expect(await attached()).toEqual([])
    await expect(pending).toBeVisible()
    page.on("dialog", (dialog) => void dialog.accept())
    await page.reload()
    await expect(pending).toBeVisible({ timeout: 30_000 })
    expect(await sideChatId(pending)).toBe(workshopId)
    await expectTextBox(box, QUESTION)
    await send.click()
    const saved = panel.locator(`[data-side-chat="${workshopId}"]`)
    await expect(saved.getByRole("article").filter({ hasText: QUESTION })).toHaveCount(1)
    await expect(saved.getByRole("article").filter({ hasText: SIDE_ANSWER })).toHaveCount(1)
    expect((await attached()).map((chat) => chat.id)).toEqual([workshopId])
  })

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`composer first, made on send, kept on reload at ${width} ${theme}`, async ({ page }, info) => {
        test.setTimeout(120_000)
        const story = await makeStory(server, `Harbor ${width} ${theme}`)
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const shot = async (name: string) => {
          if (!shots) return
          mkdirSync(shots, { recursive: true })
          await page.waitForTimeout(200)
          await page.screenshot({ path: resolve(shots, `workshop-start-${name}-${width}-${theme}.png`) })
        }
        const panelScope = width === 390 ? '[role="dialog"]' : 'aside[aria-label="Chat panel"]'

        await page.goto(`${server().url}/chats/${story.id}?panel=workshop`)
        const panel = sidePanel(page)
        const pending = pendingSideChat(page)
        await expect(pending).toBeVisible({ timeout: 30_000 })
        const draftId = await sideChatId(pending)
        await shot("opened")

        // The chat's own surface, before it's started: "new" in its header, what it is on the
        // badge's hover, the composer, focused, with the strip's model and preset chips.
        await expectNewSideHint(page)
        await expect(panel.getByRole("button", { name: /^Start a workshop$/ })).toHaveCount(0)
        const box = panel.getByLabel("Message", { exact: true })
        await expect(box).toBeVisible()
        await expect(box).toBeFocused()
        const send = panel.getByRole("button", { name: /^Send( as .+)?$/ })
        await expect(panel.getByRole("button", { name: /^Model: / })).toBeVisible()
        await expect(panel.getByRole("button", { name: /^Prompt preset: / })).toBeVisible()
        // The saved workshop's composer before the first send (workshopstart2): the speaker
        // chip, Guidance and Generate, and the capability chip, changeable already.
        await expect(panel.getByRole("switch", { name: "Guidance" })).toBeVisible()
        await expect(panel.getByTestId("composer-controls").getByRole("button", { name: /^Generate/ })).toBeVisible()
        const chip = panel.getByRole("button", { name: /^What the assistant may do: / })
        await expect(chip).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await expectLayout(page, info, `workshop-start-pending-${width}-${theme}`, { scope: panelScope })
        await chip.click()
        const grantRow = page
          .getByRole("dialog", { name: "What the assistant may do" })
          .locator('[data-capability="library.write"]')
        await grantRow.getByRole("button", { name: "Ask first", exact: true }).click()
        await expect(grantRow).toHaveAttribute("data-mode", "ask")
        await page.keyboard.press("Escape")
        await expect(chip).toHaveAccessibleName(/asking first/)
        await box.focus()
        expect(
          await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListAttachedWorkshops({ chatId: story.id }))
        ).toEqual([])

        // The first send makes the workshop and sends the message, in one action.
        await box.fill(QUESTION)
        // Send once there is text to send, as in a saved workshop.
        await expect(send).toBeVisible()
        await send.click()
        await expect(page).toHaveURL(/[?&]workshop=[^&]+/)
        const workshopId = new URL(page.url()).searchParams.get("workshop")!
        expect(workshopId).toBe(draftId)
        const side = panel.locator(`[data-side-chat="${workshopId}"]`)
        await expect(side).toBeVisible()
        await expect(side.getByRole("article").filter({ hasText: QUESTION })).toHaveCount(1)
        await expect(side.getByRole("article").filter({ hasText: SIDE_ANSWER })).toHaveCount(1, { timeout: 60_000 })
        await expect(pending).toHaveCount(0)
        await expectTextBox(side.getByLabel("Message", { exact: true }), "")
        const attached = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          api.ListAttachedWorkshops({ chatId: story.id })
        )
        expect(attached.map((chat) => chat.id)).toEqual([workshopId])
        // The grant chosen before the send is the workshop's.
        const granted = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          api.ListWorkshopCapabilities({ chatId: workshopId as never })
        )
        expect(granted.find((c) => c.id === "library.write")?.mode).toBe("ask")
        await shot("sent")
        await expectLayout(page, info, `workshop-start-sent-${width}-${theme}`, { scope: panelScope })

        // A reload keeps it: the same workshop, its messages, started.
        await page.reload()
        await expect(side.getByRole("article").filter({ hasText: QUESTION })).toHaveCount(1, { timeout: 30_000 })
        await expect(side.getByRole("article").filter({ hasText: SIDE_ANSWER })).toHaveCount(1)
        await expect(pending).toHaveCount(0)
        await shot("reloaded")
      })

  for (const width of [1440, 390])
    test(`the first send moves nothing in the tab at ${width}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      const story = await makeStory(server, `Harbor boxes ${width}`)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
      await page.addInitScript(() => localStorage.setItem("dreamspan.theme", "dark"))
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const shot = async (name: string) => {
        if (!shots) return
        mkdirSync(shots, { recursive: true })
        await page.waitForTimeout(200)
        await page.screenshot({ path: resolve(shots, `sidedraft-${name}-${width}-dark.png`) })
      }
      await page.goto(`${server().url}/chats/${story.id}?panel=workshop`)
      const panel = sidePanel(page)
      const pending = pendingSideChat(page)
      await expect(pending).toBeVisible({ timeout: 30_000 })
      // The side chat whichever it is: the pending one, then the started one in its place.
      const side = panel.locator("[data-side-chat]")
      const first = side.getByRole("article").first()
      await expect(first).toBeVisible()
      const strip = side.locator('[aria-label="Next reply"]').first()
      const places = async () => ({
        header: await side.locator("[data-side-chat-header]").boundingBox(),
        greeting: await first.boundingBox(),
        composer: await side.getByTestId("composer-box").boundingBox(),
        strip: await strip.boundingBox(),
        chips: await strip
          .getByRole("button")
          .allInnerTexts()
          .then((texts) => texts.map((text) => text.replace(/[0-9.]+k?/g, "#")))
      })
      await page.waitForTimeout(300)
      const before = await places()
      expect(before.header).not.toBeNull()
      expect(before.composer).not.toBeNull()
      expect(before.chips.length).toBeGreaterThan(0)
      await shot("before")
      await expectLayout(page, info, `sidedraft-before-${width}`, {
        scope: width === 390 ? '[role="dialog"]' : 'aside[aria-label="Chat panel"]'
      })

      // The first send starts it in place: its greeting stays message #1, and nothing moved.
      await panel.getByLabel("Message", { exact: true }).fill(QUESTION)
      await panel.getByRole("button", { name: /^Send( as .+)?$/ }).click()
      await expect(page).toHaveURL(/[?&]workshop=[^&]+/, { timeout: 30_000 })
      await expect(pending).toHaveCount(0)
      await expect(side.getByRole("article").filter({ hasText: SIDE_ANSWER })).toHaveCount(1, { timeout: 60_000 })
      // Its answer is in: the strip is as it rests.
      await expect(side.getByTestId("composer-controls").getByRole("button", { name: /^Generate/ })).toBeVisible()
      // The new message and its answer sit below the greeting: the greeting is where it was
      // once the list keeps its top (the list may scroll to the newest at this height).
      await side.getByTestId("side-chat-messages").hover()
      await page.mouse.wheel(0, -100_000)
      await page.waitForTimeout(500)
      await expect.poll(places, { timeout: 30_000 }).toEqual(before)
      await shot("after")
      await expectLayout(page, info, `sidedraft-after-${width}`, {
        scope: width === 390 ? '[role="dialog"]' : 'aside[aria-label="Chat panel"]'
      })
    })

  test("a second workshop started in the tab keeps the first in its picker", async ({ page }) => {
    test.setTimeout(120_000)
    const story = await makeStory(server, "Harbor two")
    await page.setViewportSize({ width: 1440, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${story.id}?panel=workshop`)
    const panel = sidePanel(page)
    const pending = pendingSideChat(page)
    const started = async () => {
      await expect(pending).toBeVisible({ timeout: 30_000 })
      const id = await sideChatId(pending)
      await panel.getByLabel("Message", { exact: true }).fill(QUESTION)
      await panel.getByRole("button", { name: /^Send( as .+)?$/ }).click()
      const side = panel.locator(`[data-side-chat="${id}"]`)
      await expect(side.getByRole("article").filter({ hasText: SIDE_ANSWER })).toHaveCount(1, { timeout: 60_000 })
      await expect(pending).toHaveCount(0)
      return id
    }
    await started()
    await panel.getByRole("button", { name: /^Workshop: / }).click()
    await page.getByRole("menuitem", { name: /^New workshop/ }).click()
    await started()
    await panel.getByRole("button", { name: /^Workshop: / }).click()
    const items = page.getByRole("menuitem")
    // Both workshops, then New workshop.
    await expect(items).toHaveCount(3)
  })
})
