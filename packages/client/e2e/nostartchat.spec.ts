// The remaining new-chat routes and card browsing without bare versions.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { showAppNavigation, hideAppNavigation } from "./support/appMenu.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const version = "BARE-VERSION-MUST-STAY-IN-EDITOR"

for (const width of [1440, 390]) {
  test(`${width}: used character, character tab and version-free browsing`, async ({ page }) => {
    const { card, chat } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const card = yield* api.CreateCard({ label: `Mira ${width}`, name: `Mira ${width}`, version })
        const started = yield* api.StartChat({
          cards: [card.entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "Mira waves.", speakerEntityId: card.entityId }
        })
        const chat = started.chat
        return { card, chat }
      })
    )
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(server().url)
    await expect(page.getByRole("main").getByText(version, { exact: true })).toHaveCount(0)
    await showAppNavigation(page)
    const navigation = width === 390 ? page.locator(".fixed.inset-0") : page.getByRole("complementary").first()
    await expect(navigation.getByRole("button", { name: "Start a chat", exact: true })).toHaveCount(0)
    await navigation.getByRole("group", { name: "Left panel", exact: true }).getByText("Characters").click()
    await expect(navigation.getByText(version, { exact: true })).toHaveCount(0)
    await navigation.getByRole("button", { name: `Open ${card.label}`, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/chats/${chat.id}`))
    expect(new URL(page.url()).searchParams.get("character")).toBe(card.entityId)
    if (width === 1440) {
      await expect(navigation.getByRole("button", { name: /^Open chat / }).first()).toBeVisible()
    }
    await hideAppNavigation(page)
    await page.goto(`${server().url}/chats/${chat.id}?panel=card:${card.entityId}`)
    await page.getByRole("link", { name: `New chat with ${card.label}`, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/cards/${card.entityId}/chat`))
    await page.goto(`${server().url}/library`)
    await expect(page.getByRole("main").getByText(version, { exact: true })).toHaveCount(0)
    await page.goto(`${server().url}/library/${card.id}`)
    await expect(page.getByRole("main").getByText(version, { exact: true }).first()).toBeVisible()
  })
}
