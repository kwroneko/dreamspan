import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`shell opens exact same-tip peer at ${width} ${theme}`, async ({ page }) => {
      const data = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const a = yield* api.CreateCard({ label: `Identity ${width} ${theme}`, name: `Identity ${width} ${theme}` })
          const b = yield* api.CreateCard({ label: `Companion ${width} ${theme}`, name: `Companion ${width} ${theme}` })
          const start = yield* api.StartChat({
            cards: [a.entityId, b.entityId],
            persona: null,
            greeting: null,
            first: { _tag: "Send", content: "Shared checkpoint text", speakerEntityId: a.entityId }
          })
          const original = (yield* api.ListForks({ chatId: start.chat.id }))[0]!
          yield* api.NameFork({ forkId: original.id, name: `Original ${width} ${theme}` })
          const peer = (yield* api.CreateFork({
            chatId: start.chat.id,
            fromForkId: original.id,
            atSlotId: original.tipSlotId
          })).fork
          yield* api.NameFork({ forkId: peer.id, name: `Checkpoint ${width} ${theme}` })
          yield* api.PinFork({ forkId: original.id, pinned: true })
          yield* api.PinFork({ forkId: peer.id, pinned: true })
          yield* api.SetChatPin({ chatId: start.chat.id, leaf: null, pinned: true })
          return {
            a,
            chatName: `Identity ${width} ${theme} & Companion ${width} ${theme}`,
            currentForkId: (yield* api.GetChat({ chatId: start.chat.id })).currentForkId,
            original: { ...original, name: `Original ${width} ${theme}` },
            peer: { ...peer, name: `Checkpoint ${width} ${theme}` },
            chatId: start.chat.id
          }
        })
      )
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await page.goto(server().url)
      const pins = page.getByRole("main").getByRole("region", { name: "Pinned chats", exact: true })
      // Global pins are chats, represented once by the current branch.
      const pin = pins.getByRole("link", { name: `Open chat ${data.chatName}`, exact: true })
      await expect(pin).toHaveCount(1)
      await expect(pin).toBeVisible()
      await expect(page.locator("html")).toHaveCSS("color-scheme", theme)
      const screens = process.env.SCREENSHOT_DIR
      if (screens) {
        await mkdir(screens, { recursive: true })
        await page.screenshot({ path: join(screens, `shell-forks-${width}-${theme}.png`), fullPage: true })
      }
      // The original shares its tip with the current peer; a leaf-only URL opens the peer.
      await pin.click()
      await expect(page).toHaveURL(new RegExp(`fork=${data.currentForkId}`))
      await expect(page.getByRole("article").filter({ hasText: "Shared checkpoint text" })).toBeVisible()
      await page.goto(server().url)
      await page
        .getByRole("main")
        .getByRole("group", { name: "Show", exact: true })
        .getByRole("button", { name: "Groups", exact: true })
        .click()
      // A group tile is the chat, shown once: it opens the chat's current branch by its id.
      await page
        .getByRole("main")
        .getByRole("link", { name: `Open chat ${data.chatName}`, exact: true })
        .last()
        .click()
      await expect(page).toHaveURL(new RegExp(`fork=${data.currentForkId}`))
      await page.goto(server().url)
      await page
        .getByRole("main")
        .getByRole("link", { name: `Open ${data.a.label}`, exact: true })
        .click()
      await expect(page).toHaveURL(/fork=/)
      // Opening a character scopes the left list on desktop; its chat's row opens that chat at its
      // current branch, never another one.
      if (width === 1440) {
        await page
          .getByRole("link", { name: `Open chat ${data.chatName}`, exact: true })
          .last()
          .click()
        await expect
          .poll(() => {
            const at = new URL(page.url())
            return { path: at.pathname, fork: at.searchParams.get("fork") ?? data.currentForkId }
          })
          .toEqual({ path: `/chats/${data.chatId}`, fork: data.currentForkId })
      }
    })
  }
