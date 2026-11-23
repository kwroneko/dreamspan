// Adversarial reading-mode regressions. Only synthetic content and the fake generator.
import { join } from "node:path"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { level1 } from "./support/summaries.ts"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { SendResult } from "@dreamspan/shared/chatApi.ts"
import type { SlotId } from "@dreamspan/shared/chat.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({
  ...withAdmin,
  ...(process.env.READING_REVIEW_DIST ? { CLIENT_DIST: process.env.READING_REVIEW_DIST } : {})
})
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const seed = () =>
  admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Synthetic reviewer", name: "Reviewer" })
      const chat = yield* api.CreateChat({ title: "Synthetic compact review" })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      let parent: SlotId | null = null
      for (let i = 0; i < 5; i++) {
        const sent: SendResult = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          reply: false,
          content:
            i === 2
              ? "A long paragraph. ".repeat(100) + "[Read this last link](https://example.com)."
              : `Short synthetic turn ${i}.`,
          speakerEntityId: card.entityId
        })
        if (sent._tag !== "Posted") throw Error("unexpected queue")
        parent = sent.entry.slotId
      }
      return chat.id
    })
  )

test("Comfortable keeps the footer inside the normal layout audit", async ({ page }) => {
  const chatId = await seed()
  await admin((api) => api.SetDisplayPrefs({ prefs: { chatDensity: "comfortable" } }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  const footer = page.locator(".message-footer").last()
  await expect(footer).toBeVisible()
  await expect(footer).not.toHaveAttribute("data-layout-audit-ignore", /inset/)
  await expect(footer).not.toHaveAttribute("data-layout-overlay")
})

test("a hovered compact footer never covers the end of the message", async ({ page }) => {
  const chatId = await seed()
  await admin((api) => api.SetDisplayPrefs({ prefs: { chatDensity: "compact" } }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  const row = page.getByRole("article").filter({ hasText: "A long paragraph." })
  const link = row.getByRole("link", { name: "Read this last link" })
  await link.scrollIntoViewIfNeeded()
  await row.hover({ position: { x: 150, y: (await row.boundingBox())!.height - 20 } })
  await expect(row.locator(".message-footer")).toHaveCSS("opacity", "1")
  expect(
    await row.evaluate((article) => {
      const box = article.querySelector(".message-footer")!.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(article.querySelector(".markdown")!)
      return [...range.getClientRects()].filter(
        (r) =>
          r.width && r.height && r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top
      ).length
    })
  ).toBe(0)
})

test("touch: tapping outside a revealed message hides its footer", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  const chatId = await seed()
  await admin((api) => api.SetDisplayPrefs({ prefs: { chatDensity: "compact" } }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  const row = page.getByRole("article").filter({ hasText: "Short synthetic turn 3." })
  await row.locator(".markdown").tap()
  await expect(row.getByRole("toolbar", { name: "Message actions" })).toBeVisible()
  await page.getByLabel("Message", { exact: true }).tap()
  await expect(row.getByRole("toolbar", { name: "Message actions" })).toHaveCount(0)
  await expect(row.locator(".message-footer")).toHaveCSS("opacity", "0")
  await row.locator(".markdown").tap()
  const next = page.getByRole("article").filter({ hasText: "Short synthetic turn 4." })
  await next.locator(".markdown").tap()
  await expect(row.getByRole("toolbar", { name: "Message actions" })).toHaveCount(0)
  await expect(next.getByRole("toolbar", { name: "Message actions" })).toBeVisible()
  await context.close()
})

test("narrow keyboard: Tab reaches the concealed version controls", async ({ page }) => {
  const chatId = await seed()
  await admin((api) => api.SetDisplayPrefs({ prefs: { chatDensity: "compact" } }))
  await page.setViewportSize({ width: 390, height: 844 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  const row = page.getByRole("article").filter({ hasText: "Short synthetic turn 3." })
  await row.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await row.locator(".markdown").evaluate((el) => {
    el.setAttribute("tabindex", "-1")
    ;(el as HTMLElement).focus({ preventScroll: true })
  })
  await expect(row.locator(".markdown")).toBeFocused()
  const previous = row.getByRole("button", { name: "Previous swipe", exact: true })
  for (let step = 0; step < 10; step++) {
    await page.keyboard.press("Tab")
    if (await previous.evaluate((el) => el === document.activeElement)) break
  }
  await expect(previous).toBeFocused()
  await expect(row.locator(".message-footer")).toHaveCSS("opacity", "1")
  await expect(row.getByRole("button", { name: "Previous swipe", exact: true })).toBeInViewport()
  await expect(row.getByRole("button", { name: "More actions", exact: true })).toBeVisible()
})

test("a second tab receives the account's spacing choice", async ({ context, page }) => {
  const chatId = await seed()
  await admin((api) => api.SetDisplayPrefs({ prefs: { chatDensity: "comfortable" } }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  const second = await context.newPage()
  await second.goto(`${server().url}/chats/${chatId}`)
  await expect(second.getByTestId("messages")).toHaveAttribute("data-chat-density", "comfortable")
  const panel = await openPanel(page, "Interface")
  await panel.getByRole("radio", { name: /^Compact/ }).click()
  await expect(second.getByTestId("messages")).toHaveAttribute("data-chat-density", "compact")
  await panel.getByRole("radio", { name: /^Comfortable/ }).click()
  await expect(second.getByTestId("messages")).toHaveAttribute("data-chat-density", "comfortable")
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`compact media, long names, RTL, 50 versions and summaries (${width} ${theme})`, async ({ browser }, info) => {
      test.setTimeout(180_000)
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 900 },
        colorScheme: theme,
        ...(width === 390 ? { isMobile: true, hasTouch: true } : {})
      })
      await context.addInitScript((theme) => localStorage.setItem("dreamspan.theme", theme), theme)
      const page = await context.newPage()
      const chatId = await seed()
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chatId}`)
      const image = await page.evaluate(() => {
        const canvas = document.createElement("canvas")
        canvas.width = 320
        canvas.height = 200
        const ctx = canvas.getContext("2d")!
        ctx.fillStyle = "#32808a"
        ctx.fillRect(0, 0, 320, 200)
        return canvas.toDataURL("image/png").split(",")[1]!
      })
      const upload = await page.request.post(`${server().url}/chat/image`, {
        headers: { "content-type": "application/octet-stream" },
        data: Buffer.from(image, "base64")
      })
      expect(upload.ok()).toBe(true)
      const { mediaId } = (await upload.json()) as { mediaId: string }
      const data = await admin((api) =>
        Effect.gen(function* () {
          yield* api.SetDisplayPrefs({ prefs: { chatDensity: "compact", timeline: "originals" } })
          const card = yield* api.CreateCard({
            label: "Synthetic long name",
            name: "A very long synthetic harbor keeper name ".repeat(8)
          })
          yield* api.ChangeCast({ chatId, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
          const path = yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 20 })
          let parent = path.entries.at(-1)!.slotId
          let versioned = path.entries[3]!
          for (let i = 1; i < 50; i++)
            versioned = yield* api.WriteVersion({
              slotId: versioned.slotId,
              expectedRowVersion: versioned.rowVersion,
              content: `Short synthetic turn 3. Take ${i}.`
            })
          const slots: SlotId[] = []
          for (const content of ["", "مرحبا بالعالم. هذه رسالة قصيرة من الميناء. ".repeat(12)]) {
            const sent: SendResult = yield* api.SendMessage({
              chatId,
              parentSlotId: parent,
              branch: false,
              reply: false,
              content,
              images: [{ mediaId, altText: "Synthetic harbor image" }],
              speakerEntityId: card.entityId
            })
            if (sent._tag !== "Posted") throw Error("unexpected queue")
            parent = sent.entry.slotId
            slots.push(parent)
          }
          const tail = yield* api.SendMessage({
            chatId,
            parentSlotId: parent,
            branch: false,
            reply: false,
            content: "Synthetic media tail."
          })
          if (tail._tag !== "Posted") throw Error("unexpected queue")
          const chat = yield* api.GetChat({ chatId })
          yield* api.SendMessage({
            chatId,
            parentSlotId: path.entries[2]!.slotId,
            branch: true,
            reply: false,
            content: "An alternate synthetic branch."
          })
          return { path, slots, versioned, forkId: chat.currentForkId! }
        })
      )
      await page.goto(`${server().url}/chats/${chatId}?fork=${data.forkId}`)
      for (const slot of data.slots) {
        const row = page.locator(`article[data-slot="${slot}"]`)
        await row.scrollIntoViewIfNeeded()
        if (width === 390) await row.locator("header").tap()
        else await row.hover()
        const footer = row.locator(".message-footer")
        await expect(footer).toHaveCSS("opacity", "1")
        const overlap = await row.evaluate((article) => {
          const footer = article.querySelector(".message-footer")!.getBoundingClientRect()
          const images = [...article.querySelectorAll("img")].map((el) => el.getBoundingClientRect())
          const ranges = [...article.querySelectorAll(".markdown")].flatMap((el) => {
            const r = document.createRange()
            r.selectNodeContents(el)
            return [...r.getClientRects()]
          })
          return [...images, ...ranges].some(
            (r) =>
              r.width &&
              r.height &&
              r.left < footer.right &&
              r.right > footer.left &&
              r.top < footer.bottom &&
              r.bottom > footer.top
          )
        })
        expect(overlap).toBe(false)
        await expectLayout(page, info, `compact media ${width} ${theme}`, { hovered: true })
        if (process.env.SCREENSHOT_DIR)
          await page.screenshot({
            path: join(process.env.SCREENSHOT_DIR, `compact-media-${data.slots.indexOf(slot)}-${width}-${theme}.png`)
          })
      }
      await page.goto(`${server().url}/chats/${chatId}?fork=${data.forkId}`)
      await page.getByTestId("messages").evaluate((el) => {
        el.scrollTop = 0
      })
      const versioned = page.locator(`article[data-slot="${data.versioned.slotId}"]`)
      await versioned.scrollIntoViewIfNeeded()
      if (width === 390) await versioned.locator(".markdown").tap()
      else await versioned.hover()
      const branches = versioned.getByRole("group", { name: /^Branches:/ })
      await expect(branches).toBeVisible()
      if (width === 1440)
        for (const button of await branches.getByRole("button").all()) {
          const box = (await button.boundingBox())!
          expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24)
        }
      await versioned.getByRole("button", { name: /Swipe .*50|50 swipes|choose a swipe/ }).click()
      await page.keyboard.press("Escape")
      await level1(server().dataDir, chatId, data.path.entries.slice(0, 2), "Synthetic summary of the harbor opening.")
      await admin((api) => api.SetDisplayPrefs({ prefs: { timeline: "summaries" } }))
      await page.goto(`${server().url}/chats/${chatId}?fork=${data.forkId}&slot=${data.path.entries[0]!.slotId}`)
      await page.getByTestId("messages").evaluate((el) => {
        el.scrollTop = 0
      })
      await expect(page.locator("[data-timeline-summary]").first()).toBeVisible()
      await expectLayout(page, info, `compact summary ${width} ${theme}`)
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `compact-summary-${width}-${theme}.png`) })
      await context.close()
    })

test("compact branch arrows retain 24 px mouse targets", async ({ page }) => {
  const chatId = await seed()
  const data = await admin((api) =>
    Effect.gen(function* () {
      yield* api.SetDisplayPrefs({ prefs: { chatDensity: "compact" } })
      const chat = yield* api.GetChat({ chatId })
      const path = yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      yield* api.SendMessage({
        chatId,
        parentSlotId: path.entries[2]!.slotId,
        branch: true,
        reply: false,
        content: "Synthetic alternate."
      })
      return { forkId: chat.currentForkId!, slotId: path.entries[3]!.slotId }
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}?fork=${data.forkId}`)
  const row = page.locator(`article[data-slot="${data.slotId}"]`)
  await row.scrollIntoViewIfNeeded()
  const group = row.getByRole("group", { name: /^Branches:/ })
  await expect(group).toBeVisible()
  for (const button of await group.getByRole("button").all()) {
    const box = (await button.boundingBox())!
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24)
  }
})
