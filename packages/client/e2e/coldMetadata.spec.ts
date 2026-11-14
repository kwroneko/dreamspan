import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let cookie: string | undefined
const admin = async <A>(use: Parameters<typeof asUser<A>>[3]) => {
  cookie ??= await loginCookie(server(), ADMIN.handle, ADMIN.password)
  return withCookie(server(), cookie, use)
}
let otherCookie: string | undefined
const other = async <A>(use: Parameters<typeof asUser<A>>[3]) => {
  if (otherCookie === undefined) {
    await admin((api) =>
      api.CreateUser({ handle: "cold-other", displayName: "Other", role: "user", password: "synthetic-password-1" })
    )
    otherCookie = await loginCookie(server(), "cold-other", "synthetic-password-1")
  }
  return withCookie(server(), otherCookie, use)
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`cold metadata never guesses a split title or thread identity: ${width} ${theme}`, async ({ page }, info) => {
      const fixture = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: "Physical story" })
          const a = yield* api.CreateCard({ label: `Quay ${width} ${theme}`, name: "Mira" })
          const b = yield* api.CreateCard({ label: `Docks ${width} ${theme}`, name: "Tam" })
          for (const card of [a, b])
            yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "Synthetic shared opening.",
            reply: false
          })
          if (sent._tag !== "Posted") throw new Error("unexpected queue")
          const fork = yield* api.CreateFork({
            chatId: chat.id,
            fromForkId: chat.currentForkId!,
            atSlotId: sent.entry.slotId,
            name: "Split story"
          })
          yield* api.SetSplitChat({ forkId: fork.fork.id, split: true })
          const entry = (yield* api.ReadPath({
            chatId: chat.id,
            forkId: fork.fork.id,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 1
          })).entries[0]!
          yield* api.StartThreads({
            chatId: chat.id,
            forkId: fork.fork.id,
            slotId: entry.slotId,
            expectedRowVersion: entry.rowVersion,
            threads: [
              { name: "Quay", cast: [a.entityId], writesAs: null },
              { name: "Docks", cast: [b.entityId], writesAs: null }
            ]
          })
          return { chatId: chat.id, forkId: fork.fork.id, slotId: entry.slotId }
        })
      )
      const held: Array<() => void> = []
      const blocked = new Set<string | number>()
      let release = false
      await page.routeWebSocket("**/rpc", (socket) => {
        const peer = socket.connectToServer()
        socket.onMessage((message) => {
          const frame = JSON.parse(String(message)) as { _tag: string; id?: string | number; tag?: string }
          if (
            frame._tag === "Request" &&
            frame.id !== undefined &&
            ["GetSplitChats", "ThreadsOf"].includes(frame.tag ?? "")
          )
            blocked.add(frame.id)
          peer.send(message)
        })
        peer.onMessage((message) => {
          const frame = JSON.parse(String(message)) as { requestId?: string | number }
          if (!release && frame.requestId !== undefined && blocked.has(frame.requestId))
            held.push(() => socket.send(message))
          else socket.send(message)
        })
      })
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${fixture.chatId}?fork=${fixture.forkId}&slot=${fixture.slotId}`)
      await expect(page.locator(`article[data-slot="${fixture.slotId}"]`)).toBeVisible()
      await expect.poll(() => held.length).toBeGreaterThan(1)
      const header = page.locator("header[data-center-header]").first()
      await expect(header).toBeVisible()
      await expect.soft(header.getByRole("heading", { name: "Physical story", exact: true })).toHaveCount(0)
      await expect.soft(header.locator('button[aria-label^="Branch:"]')).toHaveCount(0)
      await expect(header.getByLabel("Loading the chat", { exact: true })).toBeVisible()
      await expectLayout(page, info, "cold split and thread metadata")
      await header.getByRole("button", { name: "Chat actions", exact: true }).click()
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
      release = true
      for (const send of held.splice(0)) send()
      const rename = header.getByRole("textbox", { name: "Chat name", exact: true })
      await expect(rename).toHaveValue("Split story")
      await rename.press("Escape")
      await expect(header.getByRole("heading", { name: "Split story", exact: true })).toBeVisible()
      await expect(header.getByRole("button", { name: /^Thread: Quay/ })).toBeVisible()
      await expectLayout(page, info, "resolved split and thread metadata")
    })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`deleted and foreign deep links reveal no content before the library: ${width} ${theme}`, async ({
      page
    }, info) => {
      const make = (label: string, asAccount: typeof admin) =>
        asAccount((api) =>
          Effect.gen(function* () {
            const chat = yield* api.CreateChat({ title: label })
            const sent = yield* api.SendMessage({
              chatId: chat.id,
              parentSlotId: null,
              branch: false,
              content: `${label} private message`,
              reply: false
            })
            if (sent._tag !== "Posted") throw new Error("unexpected queue")
            return { chat, slot: sent.entry.slotId }
          })
        )
      const deleted = await make(`Deleted synthetic secret ${width} ${theme}`, admin)
      await admin((api) => api.DeleteChat({ chatId: deleted.chat.id }))
      const foreign = await make(`Foreign synthetic secret ${width} ${theme}`, other)
      const secrets = [deleted.chat.title, foreign.chat.title]
      await page.addInitScript((privateTitles) => {
        const seen: string[] = []
        new MutationObserver(() => {
          for (const secret of privateTitles)
            if (document.documentElement.textContent?.includes(secret)) seen.push(secret)
        }).observe(document, { childList: true, subtree: true, characterData: true })
        Object.assign(window, { __coldLeaks: seen })
      }, secrets)
      await page.routeWebSocket("**/rpc", (socket) => {
        const peer = socket.connectToServer()
        const blocked = new Set<string | number>()
        socket.onMessage((message) => {
          const frame = JSON.parse(String(message)) as { _tag: string; id?: string | number; tag?: string }
          if (
            frame._tag === "Request" &&
            frame.id !== undefined &&
            ["WatchShellCards", "WatchShellForks"].includes(frame.tag ?? "")
          )
            blocked.add(frame.id)
          peer.send(message)
        })
        peer.onMessage((message) => {
          const frame = JSON.parse(String(message)) as { requestId?: string | number }
          if (frame.requestId === undefined || !blocked.has(frame.requestId)) socket.send(message)
        })
      })
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      for (const target of [deleted, foreign]) {
        await page.goto(`${server().url}/chats/${target.chat.id}?slot=${target.slot}`)
        await expect(page.getByRole("alert").filter({ hasText: /^This chat doesn't exist any more\.$/ })).toBeVisible()
        await expect(page.locator("article[data-slot]")).toHaveCount(0)
        for (const secret of secrets) await expect(page.getByText(secret, { exact: true })).toHaveCount(0)
        expect(await page.evaluate(() => (window as unknown as { __coldLeaks: string[] }).__coldLeaks)).toEqual([])
        await expectLayout(page, info, "unavailable cold deep link")
      }
    })
