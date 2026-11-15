// Opt-in pixel comparison against an independently built master client on the same synthetic DB.
// READING_MASTER_DIST names that build; no snapshot is blessed by updating this branch's output.
import { readFileSync, mkdirSync } from "node:fs"
import { extname, join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { SendResult } from "@rp/shared/chatApi.ts"
import type { SlotId } from "@rp/shared/chat.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { messageMenu } from "./support/message.ts"
import { closePanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)
const reference = process.env.READING_MASTER_DIST
let cookie = ""
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use)

const fixtures = () =>
  admin((api) =>
    Effect.gen(function* () {
      yield* api.SetDisplayPrefs({ prefs: { chatDensity: "comfortable" } })
      const card = yield* api.CreateCard({ label: "Synthetic pixel comparison", name: "Mira" })
      const make = (title: string) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
          let parent: SlotId | null = null
          for (let i = 0; i < 4; i++) {
            const sent: SendResult = yield* api.SendMessage({
              chatId: chat.id,
              parentSlotId: parent,
              branch: false,
              reply: false,
              content: `Synthetic harbor turn ${i}. The lamps come on along the pier.\n\nThe keeper counts the crates again.`,
              speakerEntityId: card.entityId
            })
            if (sent._tag !== "Posted") throw Error("unexpected queue")
            parent = sent.entry.slotId
          }
          return { ...chat, tip: parent! }
        })
      const story = yield* make("Pixel story")
      const merged = yield* make("Pixel merged")
      const source = yield* make("Pixel source")
      const request = {
        chatId: merged.id,
        forkId: merged.currentForkId!,
        at: null,
        source: { chatId: source.id, forkId: source.currentForkId! },
        includeLeftOut: true
      }
      const preview = yield* api.PreviewChatMerge(request)
      yield* api.MergeChat({ ...request, title: "Pixel source", framing: null, digest: preview.digest })
      const threaded = yield* make("Pixel threads")
      const entry = (yield* api.ReadPath({
        chatId: threaded.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 1
      })).entries[0]!
      yield* api.StartThreads({
        chatId: threaded.id,
        forkId: threaded.currentForkId!,
        slotId: entry.slotId,
        expectedRowVersion: entry.rowVersion,
        threads: [
          { name: "Harbor", cast: [card.entityId], writesAs: null },
          { name: "Market", cast: [card.entityId], writesAs: null }
        ]
      })
      const workshop = yield* api.CreateWorkshop({ attachTo: story.id })
      yield* api.SendMessage({
        chatId: workshop.id,
        parentSlotId:
          (yield* api.ReadPath({
            chatId: workshop.id,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 1
          })).entries.at(-1)?.slotId ?? null,
        branch: false,
        reply: false,
        content: "A synthetic workshop question."
      })
      return { story, merged, threaded, workshop }
    })
  )

const differingPixels = (page: Page, a: Buffer, b: Buffer) =>
  page.evaluate(
    async ([a, b]) => {
      const pixels = async (base64: string) => {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        const canvas = document.createElement("canvas")
        canvas.width = image.width
        canvas.height = image.height
        const ctx = canvas.getContext("2d")!
        ctx.drawImage(image, 0, 0)
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data
      }
      const [x, y] = await Promise.all([pixels(a!), pixels(b!)])
      // A phone's Workshop sheet covers the story. Its header/composer must not be
      // classified as story-message pixels merely because that list lies behind it.
      const side = document.querySelector<HTMLElement>('[data-testid="side-chat-messages"]')
      const selector =
        innerWidth < 1024 && side?.checkVisibility()
          ? '[data-testid="side-chat-messages"]'
          : '[data-testid="messages"], [data-testid="side-chat-messages"]'
      const lists = [...document.querySelectorAll(selector)].map((el) => el.getBoundingClientRect())
      const changes: Array<{ x: number; y: number; delta: number }> = []
      let messagePixels = 0
      let maxDelta = 0
      for (let i = 0; i < x.length; i += 4) {
        const delta = Math.max(...[0, 1, 2, 3].map((c) => Math.abs(x[i + c]! - y[i + c]!)))
        if (!delta) continue
        const px = (i / 4) % innerWidth,
          py = Math.floor(i / 4 / innerWidth)
        changes.push({ x: px, y: py, delta })
        maxDelta = Math.max(maxDelta, delta)
        if (lists.some((r) => px >= r.left && px < r.right && py >= r.top && py < r.bottom)) messagePixels++
      }
      return { count: changes.length, messagePixels, maxDelta, pixels: changes }
    },
    [a.toString("base64"), b.toString("base64")]
  )

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`Comfortable matches master pixels (${width} ${theme})`, async ({ browser }, info) => {
      test.skip(!reference, "Supply the separately built master client with READING_MASTER_DIST")
      test.setTimeout(240_000)
      const f = await fixtures()
      const pages: Page[] = []
      for (const master of [true, process.env.READING_PARITY_CONTROL === "1"]) {
        const context = await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 900 },
          colorScheme: theme,
          reducedMotion: "reduce",
          permissions: ["local-network-access"]
        })
        await context.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
        await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
        const page = await context.newPage()
        await page.route("**/healthz", async (route) => {
          const response = await route.fetch()
          await route.fulfill({ response, headers: { ...response.headers(), "x-client-build": "" } })
        })
        if (master)
          await page.route("**/*", async (route) => {
            const request = route.request()
            const path = new URL(request.url()).pathname
            if (request.isNavigationRequest() && request.resourceType() === "document")
              return route.fulfill({ contentType: "text/html", body: readFileSync(join(reference!, "index.html")) })
            if (path.startsWith("/assets/"))
              return route.fulfill({
                contentType:
                  ({ ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" } as Record<string, string>)[
                    extname(path)
                  ] ?? "application/octet-stream",
                body: readFileSync(join(reference!, path))
              })
            await route.fallback()
          })
        pages.push(page)
      }
      for (const [name, path] of [
        ["chat", `/chats/${f.story.id}`],
        ["selection", `/chats/${f.story.id}`],
        ["workshop", `/chats/${f.workshop.id}`],
        ["side-chat", `/chats/${f.story.id}?panel=workshop&workshop=${f.workshop.id}`],
        ["threads", `/chats/${f.threaded.id}`],
        ["merged", `/chats/${f.merged.id}`]
      ]) {
        const shots: Buffer[] = []
        for (const [index, page] of pages.entries()) {
          await page.bringToFront()
          await page.goto(`${server().url}${path}`)
          await expect(page.getByTestId("messages")).toBeVisible()
          if (name !== "side-chat" || width === 1440)
            await expect(page.getByTestId("messages").getByRole("article").last()).toBeVisible()
          if (name === "selection")
            await messageMenu(page.getByTestId("messages").getByRole("article").last(), "Select messages")
          if (name === "side-chat")
            await expect(page.getByTestId("side-chat-messages").getByRole("article").last()).toBeVisible()
          if (
            name !== "side-chat" &&
            width === 390 &&
            (await page.getByRole("tablist", { name: "Chat panel" }).count())
          )
            await closePanel(page)
          await page.mouse.move(0, 0)
          await page.waitForTimeout(600)
          await expectLayout(page, info, `${name} ${index === 0 ? "master" : "comfortable"} ${width} ${theme}`)
          const dir = process.env.SCREENSHOT_DIR
          if (dir) mkdirSync(dir, { recursive: true })
          shots.push(
            await page.screenshot({
              animations: "disabled",
              ...(dir
                ? {
                    path: join(
                      dir,
                      `parity-${name}-${index === 0 ? "master" : "comfortable"}${process.env.READING_PARITY_CONTROL === "1" ? "-control" : ""}-${width}-${theme}.png`
                    )
                  }
                : {})
            })
          )
        }
        const count = await differingPixels(pages[1]!, shots[0]!, shots[1]!)
        console.log(
          `[pixel parity] ${name} ${width} ${theme}: ${JSON.stringify({ count: count.count, messagePixels: count.messagePixels, maxDelta: count.maxDelta })}`
        )
        await info.attach(`${name}-pixel-differences`, { body: JSON.stringify(count), contentType: "application/json" })
        // Chromium also varies rounded composer edges in master-versus-master captures.
        // Every message pixel remains exact. Only this measured, bounded 8-bit edge
        // quantization outside the message lists is accepted, with every coordinate saved.
        expect.soft(count.messagePixels, `${name} message pixels`).toBe(0)
        expect.soft(count.maxDelta, `${name} maximum channel delta outside messages`).toBeLessThanOrEqual(2)
        expect.soft(count.count, `${name} outside-message edge pixels`).toBeLessThanOrEqual(200)
        if (process.env.READING_PARITY_CONTROL === "1") break
        const compact = pages[1]!
        await admin((api) => api.SetDisplayPrefs({ prefs: { chatDensity: "compact" } }))
        await compact.reload()
        const compactList = compact.getByTestId(name === "side-chat" ? "side-chat-messages" : "messages")
        await expect(compactList).toHaveAttribute("data-chat-density", "compact")
        await expect(compactList.getByRole("article").last()).toBeVisible()
        if (name === "merged") await compactList.getByRole("button", { name: /^Merged “Pixel source”/ }).click()
        await expectLayout(compact, info, `compact ${name} ${width} ${theme}`)
        if (process.env.SCREENSHOT_DIR)
          await compact.screenshot({ path: join(process.env.SCREENSHOT_DIR, `compact-${name}-${width}-${theme}.png`) })
        await admin((api) => api.SetDisplayPrefs({ prefs: { chatDensity: "comfortable" } }))
      }
      for (const page of pages) await page.context().close()
    })
