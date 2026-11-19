import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, startServer, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`branch and chat pins at ${width} ${theme}`, async ({ page }, info) => {
      const server = await startServer(withAdmin)
      try {
        const data = await asUser(server, ADMIN.handle, ADMIN.password, (api) =>
          Effect.gen(function* () {
            const card = yield* api.CreateCard({ label: `Mira ${width} ${theme}`, name: "Mira" })
            const { chat } = yield* api.StartChat({
              cards: [card.entityId],
              persona: null,
              greeting: null,
              first: { _tag: "Send", content: "A synthetic beginning.", speakerEntityId: null }
            })
            const original = (yield* api.ListForks({ chatId: chat.id }))[0]!
            const main = (yield* api.CreateFork({
              chatId: chat.id,
              fromForkId: original.id,
              atSlotId: original.tipSlotId
            })).fork
            yield* api.NameFork({ forkId: main.id, name: "Main path" })
            const current = (yield* api.CreateFork({
              chatId: chat.id,
              fromForkId: original.id,
              atSlotId: original.tipSlotId
            })).fork
            yield* api.NameFork({ forkId: current.id, name: "Remembered path" })
            return { chat, main, current }
          })
        )
        await page.setViewportSize({ width, height: 1000 })
        await page.emulateMedia({ colorScheme: theme })
        await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
        await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
        const panel =
          width === 390
            ? page.locator('[data-layout-overlay="Mobile navigation drawer covers the page"]')
            : page.getByRole("complementary", { name: "Sidebar", exact: true })
        const go = async (branches: boolean) => {
          await page.goto(
            `${server.url}/chats/${data.chat.id}?fork=${data.current.id}&side=chats${branches ? `&forks=${data.chat.id}` : ""}`
          )
          if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
        }
        await go(true)
        const row = (name: string) =>
          panel.locator("[data-fork-row]").filter({
            has: page.getByRole("button", { name: `Open branch ${name}`, exact: true })
          })
        await expect(row("Main path")).toBeVisible()
        await row("Main path").getByRole("button", { name: "Pin Main path", exact: true }).hover()
        await expect(
          page.getByText("Click to pin this branch above the other branches in this chat", { exact: true })
        ).toBeVisible()
        await row("Main path").getByRole("button", { name: "Pin Main path", exact: true }).click()
        await expect(
          panel
            .getByRole("region", { name: "Pinned branches", exact: true })
            .getByRole("button", { name: "Open branch Main path", exact: true })
        ).toBeVisible()
        await expect(
          panel
            .getByRole("region", { name: "Named branches", exact: true })
            .getByRole("button", { name: "Open branch Remembered path", exact: true })
        ).toBeVisible()
        await expect(
          panel
            .getByRole("region", { name: "Branches", exact: true })
            .getByRole("button", { name: "Open branch Original", exact: true })
        ).toBeVisible()
        const order = await panel
          .getByRole("button", { name: /^Open branch / })
          .evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label")))
        expect(order).toEqual(["Open branch Main path", "Open branch Remembered path", "Open branch Original"])
        await page.mouse.move(0, 0)
        await panel.screenshot({ path: info.outputPath(`branches-${width}-${theme}.png`) })
        await expectLayout(page, info, `pin-branches-${width}-${theme}`, { scope: "[data-fork-row]" })
        await go(false)
        await expect(panel.getByRole("region", { name: "Pinned chats", exact: true })).toHaveCount(0)
        const chats = panel.getByRole("region", { name: "Chats", exact: true })
        const pin = chats.getByRole("button", { name: /^Pin / })
        await pin.hover()
        await expect(page.getByText("Click to add this chat to Pinned", { exact: true })).toBeVisible()
        await pin.click()
        const pins = panel.getByRole("region", { name: "Pinned chats", exact: true })
        await expect(pins.getByRole("link", { name: /^Open chat / })).toHaveCount(1)
        await expect(pins.getByRole("button", { name: /^Open branch / })).toHaveCount(0)
        await page.mouse.move(0, 0)
        await panel.screenshot({ path: info.outputPath(`chats-${width}-${theme}.png`) })
        await expectLayout(page, info, `pin-chats-${width}-${theme}`, { scope: "[data-fork-row]" })
        await pins.getByRole("link", { name: /^Open chat / }).click()
        await expect(page).toHaveURL(new RegExp(`fork=${data.current.id}`))
      } finally {
        await server.stop()
      }
    })
