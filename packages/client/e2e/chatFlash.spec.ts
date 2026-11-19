import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import type { SendResult } from "@dreamspan/shared/chatApi.ts"
import type { ChatId, SlotId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { showAppNavigation } from "./support/appMenu.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({
  ...withAdmin,
  ...(process.env.CHATFLASH_CLIENT_DIST ? { CLIENT_DIST: process.env.CHATFLASH_CLIENT_DIST } : {})
})
let url = ""
let closeVite: (() => Promise<void>) | undefined
const diagnostic = process.env.CHATFLASH_DIAGNOSTIC === "1"
const mode = process.env.CHATFLASH_VITE ? "vite" : "built"
test.beforeAll(async () => {
  url = server().url
  if (process.env.CHATFLASH_VITE) {
    const { createServer } = await import("vite")
    // Vite's config reads RP_SERVER when imported.
    process.env.RP_SERVER = url
    const dev = await createServer({
      root: process.env.CHATFLASH_CLIENT_ROOT ?? "packages/client",
      server: { port: 18871, strictPort: true }
    })
    await dev.listen()
    url = "http://localhost:18871"
    closeVite = () => dev.close()
  }
})

test.afterAll(async () => closeVite?.())

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`${width} ${theme}: first and repeat switches keep both surfaces`, async ({ browser }, info) => {
      test.skip(info.project.name !== "chromium", "Frame capture uses Chromium CDP")
      test.setTimeout(process.env.CHATFLASH_SCALE ? 180_000 : 90_000)
      const dir = info.outputPath(mode)
      mkdirSync(dir, { recursive: true })
      const ids = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const ids: ChatId[] = []
          for (const title of ["Flash harbor", "Flash forest"]) {
            const chat = yield* api.CreateChat({ title })
            let parent: SlotId | null = null
            for (let i = 0; i < 8; i++) {
              const sent: SendResult = yield* api.SendMessage({
                chatId: chat.id,
                parentSlotId: parent,
                content: `${title}: message ${i}. The lantern lights the winding path.`,
                branch: false
              })
              if (sent._tag !== "Posted") throw new Error("not posted")
              parent = sent.entry.slotId
            }
            const child = yield* api.CreateFork({
              chatId: chat.id,
              fromForkId: chat.currentForkId!,
              atSlotId: parent!,
              name: `${title} detour`
            })
            yield* api.SetSplitChat({ forkId: child.fork.id, split: true })
            ids.push(chat.id)
          }
          return ids
        })
      )
      if (process.env.CHATFLASH_SCALE) {
        await server().pause()
        execFileSync(process.execPath, [
          process.env.CHATFLASH_SCALE,
          join(server().dataDir, "rp-harness.db"),
          JSON.stringify(ids)
        ])
        await server().restart()
      }
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: theme,
        reducedMotion: "reduce",
        recordVideo: { dir }
      })
      const page = await context.newPage()
      await apiLogin(context.request, { ...server(), url }, ADMIN.handle, ADMIN.password)
      await page.goto(`${url}/chats/${ids[0]}?side=chats`)
      await expect(page.locator("article[data-slot]").last()).toBeVisible()
      const cdp = await context.newCDPSession(page)
      let frames: Array<{ t: number; data: string }> = []
      cdp.on("Page.screencastFrame", (event) => {
        frames.push({ t: event.metadata.timestamp ?? 0, data: event.data })
        void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId })
      })
      const samples = []
      for (const [index, id] of [ids[1], ids[0], ids[1]].entries()) {
        if (width < 640) await showAppNavigation(page)
        const row = page.locator(`[data-shell-list] [data-chat-id="${id}"]:visible`).first()
        await expect(row).toBeVisible()
        await expect(
          page.getByRole("region", { name: "Branches of the open chat", exact: true }).filter({ visible: true })
        ).toBeVisible()
        await expect(
          page.getByRole("region", { name: "Related chats", exact: true }).filter({ visible: true })
        ).toBeVisible()
        frames = []
        await cdp.send("Page.startScreencast", { format: "jpeg", quality: 65, everyNthFrame: 1 })
        const expectedTitle = id === ids[0] ? "Flash harbor" : "Flash forest"
        await page.evaluate((expectedTitle) => {
          const state = { start: performance.now(), samples: [] as unknown[], done: false, readyAt: 0 }
          Object.assign(window, { flashFrames: state })
          const frame = () => {
            const messages = document.querySelector('[data-testid="messages"]')
            const branches = document.querySelector('[aria-label="Branches of the open chat"]')
            state.samples.push({
              ms: performance.now() - state.start,
              loading: !!document.querySelector('[data-testid="messages-loading"]'),
              messages: messages?.querySelectorAll("article[data-slot]").length ?? 0,
              branches: branches?.querySelectorAll("[data-fork-row]").length ?? 0,
              // A folded section (the phone's closed menu sheet folds it) mounts no rows.
              branchSection: !!branches,
              branchOpen: branches?.querySelector("[data-foot-header] [aria-expanded]")?.ariaExpanded === "true",
              branchHeight: branches?.getBoundingClientRect().height ?? 0,
              branchTop: branches?.getBoundingClientRect().top ?? 0,
              splitHeight: document.querySelector('[aria-label="Related chats"]')?.getBoundingClientRect().height ?? 0,
              split: !!document.querySelector('[aria-label="Related chats"]'),
              main: document.querySelector("main")?.textContent?.slice(0, 180)
            })
            const now = performance.now()
            const ready =
              document.querySelector("[data-chat-main] h1")?.textContent?.trim() === expectedTitle &&
              !!messages?.querySelector("article[data-slot]") &&
              !document.querySelector('[data-testid="messages-loading"]')
            if (ready && state.readyAt === 0) state.readyAt = now
            if (!ready) state.readyAt = 0
            if (now - state.start < 1200 || state.readyAt === 0 || now - state.readyAt < 200)
              requestAnimationFrame(frame)
            else state.done = true
          }
          requestAnimationFrame(frame)
        }, expectedTitle)
        await row.click()
        await page.waitForFunction(() => (window as unknown as { flashFrames: { done: boolean } }).flashFrames.done)
        await cdp.send("Page.stopScreencast")
        const data = await page.evaluate(
          () =>
            (
              window as unknown as {
                flashFrames: {
                  samples: Array<{
                    loading: boolean
                    messages: number
                    branches: number
                    branchSection: boolean
                    branchOpen: boolean
                    split: boolean
                    branchHeight: number
                    branchTop: number
                    splitHeight: number
                  }>
                }
              }
            ).flashFrames.samples
        )
        samples.push(data)
        frames.forEach((frame, n) =>
          writeFileSync(
            join(dir, `switch-${index}-${String(n).padStart(3, "0")}.jpg`),
            Buffer.from(frame.data, "base64")
          )
        )
        writeFileSync(join(dir, `switch-${index}-frames.json`), JSON.stringify(frames.map(({ t }, n) => ({ t, n }))))
        writeFileSync(join(dir, "samples.json"), JSON.stringify(samples, null, 2))
        if (!diagnostic) {
          expect(
            data.filter((frame) => frame.loading || frame.messages === 0),
            "no centre fallback or empty message frame"
          ).toEqual([])
          expect(
            data.filter((frame) => !frame.split),
            "no collapsed split section"
          ).toEqual([])
          expect(
            data.filter((frame) => !frame.branchSection || (frame.branchOpen && frame.branches === 0)),
            "no collapsed branch viewer"
          ).toEqual([])
        }
        if (!diagnostic && width >= 640) {
          for (const key of ["branchHeight", "branchTop", "splitHeight"] as const) {
            const values = data.map((frame) => frame[key])
            expect(
              Math.max(...values) - Math.min(...values),
              `${key} stays stable during the handover`
            ).toBeLessThanOrEqual(1)
          }
        }
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(
          id === ids[0] ? "Flash harbor" : "Flash forest",
          { timeout: 30_000 }
        )
        await expect(page.locator("article[data-slot]").last()).toBeVisible()
      }
      writeFileSync(join(dir, "samples.json"), JSON.stringify(samples, null, 2))
      if (process.env.LAYOUT_AUDIT) {
        if (width < 640) await showAppNavigation(page)
        const violations = await expectLayout(page, info, "chat-switch", {
          scope: '[data-chat-main], [aria-label="Branches of the open chat"], [aria-label="Related chats"]'
        })
        writeFileSync(join(dir, "layout.json"), JSON.stringify(violations, null, 2))
      }
      await context.close()
    })
  }

// A slow destination must not strand the outgoing view or win a later navigation.
test("a superseded chat read cannot replace the latest pick", async ({ page }) => {
  test.skip(diagnostic, "Only the fixed handover retains the outgoing view")
  const chats = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chats = []
      for (const title of ["Handover source", "Handover held", "Handover latest"]) {
        const chat = yield* api.CreateChat({ title })
        yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: `${title} message.` })
        chats.push(chat)
      }
      return chats
    })
  )
  let release: (() => void) | undefined
  await page.routeWebSocket("**/rpc", (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((message) => {
      const text = String(message)
      if (text.includes('"tag":"SubscribeChat"') && text.includes(chats[1]!.id)) release = () => upstream.send(message)
      else upstream.send(message)
    })
    upstream.onMessage((message) => socket.send(message))
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, { ...server(), url }, ADMIN.handle, ADMIN.password)
  await page.goto(`${url}/chats/${chats[0]!.id}?side=chats`)
  const heading = page.getByRole("heading", { level: 1 })
  const pick = (index: number) => page.locator(`[data-shell-list] [data-chat-id="${chats[index]!.id}"]:visible`).click()
  await expect(heading).toHaveText(chats[0]!.title)
  const draft = page.getByLabel("Message", { exact: true })
  // Typing keeps this chat's tab open (features/workbench): the next pick opens a preview tab.
  await draft.fill("Keep this draft during the handover.")
  await pick(2)
  await expect(heading).toHaveText(chats[2]!.title)
  // The preview tab changes chats in place: a held destination keeps the outgoing view.
  await pick(1)
  await expect.poll(() => release !== undefined).toBe(true)
  await expect(heading).toHaveText(chats[2]!.title)
  await expect(page.getByTestId("messages-loading")).toHaveCount(0)
  await expect(page.locator("main [inert]")).toHaveCount(1)
  // The kept chat's tab comes back as it was.
  await pick(0)
  await expect(page.locator("main [inert]")).toHaveCount(0)
  await expect(heading).toHaveText(chats[0]!.title)
  await expect(draft).toHaveValue("Keep this draft during the handover.")
  // A later pick in the preview tab cancels the held destination, which can't replace it.
  await pick(2)
  await expect(heading).toHaveText(chats[2]!.title)
  release!()
  await pick(0)
  await expect(heading).toHaveText(chats[0]!.title)
  await expect(draft).toHaveValue("Keep this draft during the handover.")
  const tabs = page.getByRole("tablist", { name: "Open tabs", exact: true })
  await expect(tabs.getByRole("tab", { name: chats[2]!.title })).toHaveCount(1)
  await expect(tabs.getByRole("tab", { name: chats[1]!.title })).toHaveCount(0)
})
